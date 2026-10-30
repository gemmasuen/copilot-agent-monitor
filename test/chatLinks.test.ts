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
function hostSession(hostId: string, sdkId: string, mtime?: Date, title?: string): string {
  const dir = path.join(root, "agentSessionData", dataDirName(hostId));
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "session.db"));
  db.exec("CREATE TABLE session_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
  db.prepare("INSERT INTO session_metadata VALUES (?, ?)").run(
    "agentHost.chatProviderData",
    JSON.stringify({ sdkSessionId: sdkId }),
  );
  if (title) {
    db.prepare("INSERT INTO session_metadata VALUES (?, ?)").run("customTitle", title);
  }
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

/** Writes a workspace state.vscdb with VS Code's chat session index. */
function chatIndex(workspaceDir: string, titles: Record<string, string>) {
  fs.mkdirSync(workspaceDir, { recursive: true });
  const db = new DatabaseSync(path.join(workspaceDir, "state.vscdb"));
  db.exec("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  const entries = Object.fromEntries(Object.entries(titles).map(([id, title]) => [id, { sessionId: id, title }]));
  db.prepare("INSERT INTO ItemTable VALUES (?, ?)").run("chat.ChatSessionStore.index", JSON.stringify({ version: 1, entries }));
  db.close();
}

describe("session titles", () => {
  it("reads the title VS Code gave an agent-host Copilot session", async () => {
    hostSession("host-1", "cli-1", undefined, "Figures performance investigation");
    hostSession("host-2", "cli-2");
    const links = new ChatLinkResolver({ agentSessionDataDir: path.join(root, "agentSessionData") });
    expect(await links.title(copilot("cli-1", "vscode-agent-host"))).toBe("Figures performance investigation");
    expect(await links.title(copilot("cli-2", "vscode-agent-host"))).toBeUndefined();
    expect(await links.title(copilot("cli-1", "github/autopilot"))).toBeUndefined();
  });

  it("picks up a rename of an agent-host session", async () => {
    const dir = hostSession("host-1", "cli-1");
    const links = new ChatLinkResolver({ agentSessionDataDir: path.join(root, "agentSessionData") });
    expect(await links.title(copilot("cli-1", "vscode-agent-host"))).toBeUndefined();
    const db = new DatabaseSync(path.join(dir, "session.db"));
    db.prepare("INSERT INTO session_metadata VALUES (?, ?)").run("customTitle", "Issue 591 PR status");
    db.close();
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(dir, "session.db"), later, later);
    expect(await links.title(copilot("cli-1", "vscode-agent-host"))).toBe("Issue 591 PR status");
  });

  it("prefers the chat index title for agent-host sessions over session.db", async () => {
    hostSession("host-1", "cli-1", undefined, "I'm going to be away for a few hours, and...");
    hostSession("host-2", "cli-2");
    const storage = path.join(root, "workspaceStorage");
    chatIndex(path.join(storage, "hashA"), { "agent-host-copilotcli:/host-1": "Overseeing agent sessions" });
    chatIndex(path.join(storage, "hashB"), { "agent-host-copilotcli:/host-2": "Issue 591 PR status" });
    const links = new ChatLinkResolver({
      agentSessionDataDir: path.join(root, "agentSessionData"),
      workspaceStorageRoots: [storage],
    });
    expect(await links.title(copilot("cli-1", "vscode-agent-host"))).toBe("Overseeing agent sessions");
    expect(await links.title(copilot("cli-2", "vscode-agent-host"))).toBe("Issue 591 PR status");
  });

  it("reads VS Code Local chat titles and skips the untitled placeholder", async () => {
    const ws = path.join(root, "workspaceStorage", "hash1");
    chatIndex(ws, { t1: "Delete Docker folders", t2: "New Chat" });
    const links = new ChatLinkResolver({});
    expect(await links.title(transcript("t1", ws))).toBe("Delete Docker folders");
    expect(await links.title(transcript("t2", ws))).toBeUndefined();
    expect(await links.title(transcript("t3", ws))).toBeUndefined();
  });

  it("has no titles without SQLite", async () => {
    const ws = path.join(root, "workspaceStorage", "hash1");
    chatIndex(ws, { t1: "Delete Docker folders" });
    expect(await new ChatLinkResolver({ readValue: undefined }).title(transcript("t1", ws))).toBeUndefined();
  });
});
