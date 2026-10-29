import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ChatLinkResolver,
  agentHostSessionUri,
  hostSessionIdFromDataDir,
  sqliteSdkSessionIdReader,
  vscodeChatSessionUri,
} from "../src/sources/chatLinks";
import type { SessionInfo } from "../src/sources/discovery";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cam-links-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const dataDirName = (hostId: string) => `default-${Buffer.from(`copilotcli:/${hostId}`).toString("base64url")}`;

/** Creates an agentSessionData folder whose session.db points at `sdkId`. */
function hostSession(hostId: string, sdkId: string, mtime?: Date): string {
  const dir = path.join(root, "agentSessionData", dataDirName(hostId));
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "session.db"));
  db.exec("CREATE TABLE session_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
  db.prepare("INSERT INTO session_metadata VALUES (?, ?)").run(
    "agentHost.chatProviderData",
    JSON.stringify({ sdkSessionId: sdkId }),
  );
  db.close();
  if (mtime) {
    fs.utimesSync(dir, mtime, mtime);
  }
  return dir;
}

function copilot(id: string, clientName?: string): SessionInfo {
  return { key: `copilot:${id}`, id, source: "copilot", file: "", title: id, mtimeMs: 0, sizeBytes: 0, clientName };
}

function transcript(id: string, workspaceStorageDir: string): SessionInfo {
  return { key: `vscode:${id}`, id, source: "vscode", file: "", title: id, mtimeMs: 0, sizeBytes: 0, workspaceStorageDir };
}

describe("chat links", () => {
  it("builds VS Code's session link formats", () => {
    expect(vscodeChatSessionUri("ad5dc6c6-c5aa-45cd-b532-49998d7d20d5")).toBe(
      "vscode-chat-session://local/YWQ1ZGM2YzYtYzVhYS00NWNkLWI1MzItNDk5OThkN2QyMGQ1",
    );
    expect(agentHostSessionUri("91e6e9aa-509c-41d1-8b2a-f149160537f3")).toBe(
      "agent-host-session://ahp-session/91e6e9aa-509c-41d1-8b2a-f149160537f3",
    );
  });

  it("decodes agent-host data folder names and ignores others", () => {
    expect(hostSessionIdFromDataDir(dataDirName("91e6e9aa-509c"))).toBe("91e6e9aa-509c");
    expect(hostSessionIdFromDataDir("91e6e9aa-509c-41d1-8b2a-f149160537f3")).toBeUndefined();
    expect(hostSessionIdFromDataDir(`default-${Buffer.from("claude:/x").toString("base64url")}`)).toBeUndefined();
  });

  it("reads the CLI session id from an agent-host session.db", () => {
    const dir = hostSession("host-1", "cli-1");
    expect(sqliteSdkSessionIdReader()!(path.join(dir, "session.db"))).toBe("cli-1");
    expect(sqliteSdkSessionIdReader()!(path.join(root, "missing.db"))).toBeUndefined();
  });

  it("links agent-host Copilot sessions through agentSessionData", async () => {
    hostSession("host-old", "cli-old", new Date("2026-01-01"));
    hostSession("host-new", "cli-new", new Date("2026-06-01"));
    fs.mkdirSync(path.join(root, "agentSessionData", "host-new"));
    let reads = 0;
    const read = sqliteSdkSessionIdReader()!;
    const links = new ChatLinkResolver({
      agentSessionDataDir: path.join(root, "agentSessionData"),
      readSdkSessionId: (db) => (reads++, read(db)),
    });

    expect(await links.resolve(copilot("cli-new", "vscode-agent-host"))).toBe(agentHostSessionUri("host-new"));
    expect(reads).toBe(1);
    expect(await links.resolve(copilot("cli-old", "vscode-agent-host"))).toBe(agentHostSessionUri("host-old"));
    expect(await links.resolve(copilot("cli-new", "vscode-agent-host"))).toBe(agentHostSessionUri("host-new"));
    expect(reads).toBe(2);

    expect(await links.resolve(copilot("cli-gone", "vscode-agent-host"))).toBeUndefined();
    hostSession("host-later", "cli-later");
    expect(await links.resolve(copilot("cli-later", "vscode-agent-host"))).toBe(agentHostSessionUri("host-later"));
    expect(reads).toBe(3);
  });

  it("has no link for terminal Copilot sessions or without SQLite", async () => {
    hostSession("host-1", "cli-1");
    const dir = path.join(root, "agentSessionData");
    expect(await new ChatLinkResolver({ agentSessionDataDir: dir }).resolve(copilot("cli-1", "github/autopilot"))).toBeUndefined();
    expect(await new ChatLinkResolver({ agentSessionDataDir: dir }).resolve(copilot("cli-1"))).toBeUndefined();
    expect(
      await new ChatLinkResolver({ agentSessionDataDir: dir, readSdkSessionId: undefined }).resolve(
        copilot("cli-1", "vscode-agent-host"),
      ),
    ).toBeUndefined();
  });

  it("links VS Code transcripts only from this window's workspace", async () => {
    const here = path.join(root, "workspaceStorage", "hash1");
    const links = new ChatLinkResolver({ currentWorkspaceStorageDir: here });
    expect(await links.resolve(transcript("t1", here + path.sep))).toBe(vscodeChatSessionUri("t1"));
    expect(await links.resolve(transcript("t2", path.join(root, "workspaceStorage", "hash2")))).toBeUndefined();
    expect(await new ChatLinkResolver({}).resolve(transcript("t1", here))).toBeUndefined();
  });
});
