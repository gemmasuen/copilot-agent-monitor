import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverCopilotSessions, discoverVscodeTranscripts, parseWorkspaceYaml } from "../src/sources/discovery";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cam-disc-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string, mtime?: Date) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  if (mtime) {
    fs.utimesSync(p, mtime, mtime);
  }
}

describe("discovery", () => {
  it("parses workspace.yaml key/value pairs", () => {
    const y = parseWorkspaceYaml('id: abc\ncwd: c:\\repo\nname: "Fix the build"\nsummary: |\n  multi\n');
    expect(y).toEqual({ id: "abc", cwd: "c:\\repo", name: "Fix the build" });
    expect(parseWorkspaceYaml("id: abc\nname: |-\n  first line\n  second\nsummary: >+\n  x\n")).toEqual({ id: "abc" });
  });

  it("lists Copilot sessions newest first with titles", async () => {
    const state = path.join(root, "state");
    write("state/old/events.jsonl", '{"type":"session.start"}\n', new Date("2026-01-01"));
    write("state/old/workspace.yaml", "cwd: D:\\proj\\alpha\n");
    write("state/new/events.jsonl", '{"type":"session.start"}\n', new Date("2026-06-01"));
    write("state/new/workspace.yaml", "name: Build the monitor\ncwd: D:\\proj\\beta\nclient_name: vscode-agent-host\n");
    write("state/empty/events.jsonl", "");
    write("state/.session-operation-locks/x", "");

    const sessions = await discoverCopilotSessions(state);
    expect(sessions.map((s) => s.id)).toEqual(["new", "old"]);
    expect(sessions[0]).toMatchObject({
      title: "Build the monitor",
      source: "copilot",
      key: "copilot:new",
      clientName: "vscode-agent-host",
    });
    expect(sessions[1].title).toBe("alpha · old");
    expect(sessions[1].clientName).toBeUndefined();
  });

  it("lists VS Code transcripts with the first prompt as title", async () => {
    const storage = path.join(root, "workspaceStorage");
    write(
      "workspaceStorage/hash1/GitHub.copilot-chat/transcripts/t1.jsonl",
      '{"type":"session.start","data":{}}\n{"type":"user.message","data":{"content":"Where is the prompt guide?"}}\n',
    );
    write("workspaceStorage/hash1/workspace.json", JSON.stringify({ folder: "file:///d%3A/Personal_Projects/demo" }));
    const sessions = await discoverVscodeTranscripts([storage]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: "t1", source: "vscode", title: "Where is the prompt guide?" });
    expect(sessions[0].cwd).toBe("D:/Personal_Projects/demo");
    expect(sessions[0].workspaceStorageDir).toBe(path.join(storage, "hash1"));
  });

  it("returns nothing for missing folders", async () => {
    expect(await discoverCopilotSessions(path.join(root, "nope"))).toEqual([]);
    expect(await discoverVscodeTranscripts([path.join(root, "nope")])).toEqual([]);
  });
});
