import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MonitorController, MonitorTimings } from "../src/controller";
import { SessionSnapshot } from "../src/model/snapshot";
import { EventBuilder } from "./builders";

const TIMINGS: MonitorTimings = { pollMs: 60_000, discoverMs: 60_000, followQuietMs: 20_000, emitThrottleMs: 0 };

let root: string;
let stateDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cam-ctl-"));
  stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeSession(id: string, b: EventBuilder, mtime: number, name = id) {
  const dir = path.join(stateDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "events.jsonl");
  fs.writeFileSync(file, b.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "workspace.yaml"), `name: ${name}\n`);
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
}

function controller(now: () => number) {
  return new MonitorController(
    { copilotSessions: true, vscodeTranscripts: false, copilotStateDir: stateDir, vscodeStorageDirs: [], showPreviews: true },
    TIMINGS,
    now,
  );
}

describe("MonitorController", () => {
  it("follows the newest session and tails appended events live", async () => {
    const t0 = Date.parse("2026-10-20T09:00:00Z");
    let now = t0 + 1000;
    const old = new EventBuilder(t0 - 3_600_000).sessionStart();
    writeSession("old", old, t0 - 3_600_000, "Old work");
    const b = new EventBuilder(t0).sessionStart();
    const file = writeSession("new", b, t0, "New work");

    const ctl = controller(() => now);
    const snaps: (SessionSnapshot | undefined)[] = [];
    ctl.onDidChangeSnapshot((s) => snaps.push(s));
    await ctl.discover();
    expect(ctl.currentKey).toBe("copilot:new");
    expect(ctl.isLoading).toBe(false);
    expect(snaps.at(-1)?.title).toBe("New work");
    expect(ctl.sessionOptions().map((s) => s.title)).toEqual(["New work", "Old work"]);

    const more = new EventBuilder(t0 + 2000);
    more.spawn({ callId: "c1", agentId: "A", name: "live-agent" });
    fs.appendFileSync(file, more.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    now = t0 + 3000;
    await ctl.poll();
    const live = ctl.snapshot()!;
    expect(live.agents.map((a) => a.name)).toContain("live-agent");
    expect(live.counts.running).toBe(1);
    ctl.dispose();
  });

  it("does not jump away from a session that is still active, but does once it is quiet", async () => {
    const t0 = Date.parse("2026-10-20T09:00:00Z");
    let now = t0;
    writeSession("a", new EventBuilder(t0).sessionStart(), t0);
    const ctl = controller(() => now);
    await ctl.discover();
    expect(ctl.currentKey).toBe("copilot:a");

    writeSession("b", new EventBuilder(t0 + 5000).sessionStart(), t0 + 5000);
    now = t0 + 6000;
    await ctl.discover();
    expect(ctl.currentKey).toBe("copilot:a");

    now = t0 + 25_000;
    await ctl.discover();
    expect(ctl.currentKey).toBe("copilot:b");
    ctl.dispose();
  });

  it("stops following after a manual selection and resumes on request", async () => {
    const t0 = Date.parse("2026-10-20T09:00:00Z");
    const now = t0 + 60_000;
    writeSession("a", new EventBuilder(t0).sessionStart(), t0);
    writeSession("b", new EventBuilder(t0 + 1000).sessionStart(), t0 + 1000);
    const ctl = controller(() => now);
    await ctl.discover();
    expect(ctl.currentKey).toBe("copilot:b");
    await ctl.selectSession("copilot:a");
    expect(ctl.follow).toBe(false);
    expect(ctl.currentKey).toBe("copilot:a");
    await ctl.discover();
    expect(ctl.currentKey).toBe("copilot:a");
    ctl.setFollow(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(ctl.currentKey).toBe("copilot:b");
    ctl.dispose();
  });

  it("publishes the running → idle transition even when no new events arrive", async () => {
    const t0 = Date.parse("2026-10-20T09:00:00Z");
    let now = t0;
    const b = new EventBuilder(t0).sessionStart();
    b.spawn({ callId: "c1", agentId: "A", name: "worker" });
    b.complete("A", "c1");
    b.toolStart("w1", "write_agent", { agent_id: "A", message: "again" });
    b.toolComplete("w1");
    writeSession("s", b, b.now);
    now = b.now + 100;
    const ctl = controller(() => now);
    await ctl.discover();
    expect(ctl.snapshot()!.counts.running).toBe(1);

    const seen: number[] = [];
    ctl.onDidChangeSnapshot((s) => s && seen.push(s.counts.idle));
    await ctl.poll();
    now = b.now + 120_000;
    await ctl.poll();
    expect(seen.at(-1)).toBe(1);
    ctl.dispose();
  });
});
