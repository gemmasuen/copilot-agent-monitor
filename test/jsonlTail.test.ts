import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlTailer } from "../src/sources/jsonlTail";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cam-tail-"));
  file = path.join(dir, "events.jsonl");
  fs.writeFileSync(file, "");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const line = (type: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type, data: extra }) + "\n";

describe("JsonlTailer", () => {
  it("returns relevant events and skips irrelevant or huge lines", async () => {
    const huge = JSON.stringify({ type: "session.binary_asset", data: { blob: "x".repeat(200_000) } }) + "\n";
    fs.writeFileSync(
      file,
      line("session.start") + huge + "not json\n" + line("hook.start") + line("tool.execution_start", { toolName: "grep" }),
    );
    const tail = new JsonlTailer(file, { chunkSize: 4096 });
    const r = await tail.readNew();
    expect(r.events.map((e) => e.type)).toEqual(["session.start", "tool.execution_start"]);
    expect(r.reset).toBe(false);
  });

  it("handles lines split across appends and tiny chunks", async () => {
    const full = line("assistant.turn_start", { turnId: "0" }) + line("assistant.turn_end", { turnId: "0" });
    const tail = new JsonlTailer(file, { chunkSize: 7 });
    fs.appendFileSync(file, full.slice(0, 20));
    expect((await tail.readNew()).events).toHaveLength(0);
    fs.appendFileSync(file, full.slice(20, 50));
    const second = await tail.readNew();
    fs.appendFileSync(file, full.slice(50));
    const third = await tail.readNew();
    expect([...second.events, ...third.events].map((e) => e.type)).toEqual([
      "assistant.turn_start",
      "assistant.turn_end",
    ]);
  });

  it("emits a complete trailing line without newline exactly once", async () => {
    fs.writeFileSync(file, line("session.start") + JSON.stringify({ type: "session.shutdown", data: {} }));
    const tail = new JsonlTailer(file);
    expect((await tail.readNew()).events.map((e) => e.type)).toEqual(["session.start", "session.shutdown"]);
    fs.appendFileSync(file, "\n" + line("session.resume"));
    expect((await tail.readNew()).events.map((e) => e.type)).toEqual(["session.resume"]);
  });

  it("signals a reset when the file is truncated", async () => {
    fs.writeFileSync(file, line("session.start") + line("abort"));
    const tail = new JsonlTailer(file);
    await tail.readNew();
    fs.writeFileSync(file, line("user.message", { content: "hi" }));
    const r = await tail.readNew();
    expect(r.reset).toBe(true);
    expect(r.events.map((e) => e.type)).toEqual(["user.message"]);
  });

  it("reports progress per chunk", async () => {
    fs.writeFileSync(file, line("session.start").repeat(50));
    const positions: number[] = [];
    const tail = new JsonlTailer(file, { chunkSize: 256 });
    const r = await tail.readNew((_events, pos, size) => {
      positions.push(pos);
      expect(size).toBe(fs.statSync(file).size);
    });
    expect(r.events).toHaveLength(50);
    expect(positions.at(-1)).toBe(fs.statSync(file).size);
    expect(positions.length).toBeGreaterThan(1);
  });

  it("handles CRLF line endings", async () => {
    fs.writeFileSync(file, line("session.start").replace("\n", "\r\n") + line("abort").replace("\n", "\r\n"));
    const r = await new JsonlTailer(file).readNew();
    expect(r.events.map((e) => e.type)).toEqual(["session.start", "abort"]);
  });
});
