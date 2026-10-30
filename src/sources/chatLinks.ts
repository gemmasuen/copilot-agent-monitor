import * as fs from "fs";
import * as path from "path";
import type { SessionInfo } from "./discovery";

/*
 * Links that open a session's conversation in VS Code chat, and the titles VS Code shows for them. Both formats are
 * VS Code internals (checked against VS Code 1.144), not public API, so a lookup that fails simply means "no link"
 * or "no title".
 *
 * - VS Code Local chat: vscode-chat-session://local/<base64url(sessionId)>. The transcript id is the chat session id.
 * - Copilot CLI run by VS Code's agent host (workspace.yaml `client_name: vscode-agent-host`): the agent host gives
 *   the session its own id. <userData>/agentSessionData/default-<base64url("copilotcli:/<hostId>")>/session.db maps
 *   it back to the CLI session id (session_metadata 'agentHost.chatProviderData' = {"sdkSessionId": ...}). VS Code
 *   opens agent-host-session://ahp-session/<hostId>.
 *
 * Titles: each window's <workspaceStorage>/<hash>/state.vscdb has a chat index (ItemTable
 * 'chat.ChatSessionStore.index' → entries[<chat id>].title, "New Chat" until VS Code names it). The chat id is the
 * transcript id for VS Code Local chats and "agent-host-copilotcli:/<hostId>" for agent-host sessions. session.db's
 * session_metadata 'customTitle' is a fallback for agent-host sessions no window has indexed.
 */

export const AGENT_HOST_CLIENT = "vscode-agent-host";
const DATA_DIR_PREFIX = "default-";
const COPILOT_CLI_PREFIX = "copilotcli:/";
const PROVIDER_DATA_KEY = "agentHost.chatProviderData";
const CUSTOM_TITLE_KEY = "customTitle";
const CHAT_INDEX_KEY = "chat.ChatSessionStore.index";
const UNTITLED_CHAT = "New Chat";
/** How long to wait before looking again for an agent-host session that wasn't found. */
const MISS_RETRY_MS = 10_000;
/** How long the merged chat index is reused before checking the workspace databases for changes. */
const INDEX_TTL_MS = 3_000;
/** Chat index key prefix for agent-host Copilot CLI sessions, followed by the agent-host session id. */
const AGENT_HOST_CHAT_PREFIX = "agent-host-copilotcli:/";

export function vscodeChatSessionUri(sessionId: string): string {
  return `vscode-chat-session://local/${Buffer.from(sessionId, "utf8").toString("base64url")}`;
}

export function agentHostSessionUri(hostSessionId: string): string {
  return `agent-host-session://ahp-session/${encodeURIComponent(hostSessionId)}`;
}

/** Returns the agent-host session id for an agentSessionData folder name, or undefined for other folders. */
export function hostSessionIdFromDataDir(name: string): string | undefined {
  if (!name.startsWith(DATA_DIR_PREFIX)) {
    return undefined;
  }
  const decoded = Buffer.from(name.slice(DATA_DIR_PREFIX.length), "base64url").toString("utf8");
  if (!decoded.startsWith(COPILOT_CLI_PREFIX)) {
    return undefined;
  }
  const id = decoded.slice(COPILOT_CLI_PREFIX.length).replace(/^\/+/, "");
  return /^[\w-]+$/.test(id) ? id : undefined;
}

/** Reads the CLI session id an agent-host session.db points at. */
export type SdkSessionIdReader = (dbFile: string) => string | undefined;

/** Reads one text value from a VS Code SQLite file: `SELECT value FROM <table> WHERE key = ?`. */
export type SqliteValueReader = (dbFile: string, table: "session_metadata" | "ItemTable", key: string) => string | undefined;

type SqliteModule = typeof import("node:sqlite");
let sqlite: SqliteModule | null | undefined;

function loadSqlite(): SqliteModule | undefined {
  if (sqlite === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      sqlite = require("node:sqlite") as SqliteModule;
    } catch {
      sqlite = null;
    }
  }
  return sqlite ?? undefined;
}

export function sqliteValueReader(): SqliteValueReader | undefined {
  const mod = loadSqlite();
  if (!mod) {
    return undefined;
  }
  return (dbFile, table, key) => {
    if (!fs.existsSync(dbFile)) {
      return undefined;
    }
    let db: InstanceType<SqliteModule["DatabaseSync"]> | undefined;
    try {
      db = new mod.DatabaseSync(dbFile, { readOnly: true });
      const row = db.prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key) as { value?: unknown } | undefined;
      if (typeof row?.value === "string") {
        return row.value;
      }
      return row?.value instanceof Uint8Array ? Buffer.from(row.value).toString("utf8") : undefined;
    } catch {
      return undefined;
    } finally {
      try {
        db?.close();
      } catch {
        // Already closed or never opened.
      }
    }
  };
}

export function sqliteSdkSessionIdReader(): SdkSessionIdReader | undefined {
  const read = sqliteValueReader();
  if (!read) {
    return undefined;
  }
  return (dbFile) => {
    try {
      const id: unknown = JSON.parse(read(dbFile, "session_metadata", PROVIDER_DATA_KEY) ?? "null")?.sdkSessionId;
      return typeof id === "string" ? id : undefined;
    } catch {
      return undefined;
    }
  };
}

export interface ChatLinkOptions {
  /** The running VS Code's agentSessionData folder; undefined disables agent-host links. */
  agentSessionDataDir?: string;
  /** This window's workspaceStorage/<hash> folder; undefined (empty window) disables VS Code Local links. */
  currentWorkspaceStorageDir?: string;
  /** Defaults to node:sqlite; undefined when it isn't available. */
  readSdkSessionId?: SdkSessionIdReader;
  /** Reads titles; defaults to node:sqlite, undefined when it isn't available. */
  readValue?: SqliteValueReader;
  /** workspaceStorage folders whose chat indexes hold session titles. */
  workspaceStorageRoots?: string[];
}

/**
 * Resolves sessions to links that open their conversation in this VS Code window, and to the titles VS Code shows.
 * Agent-host lookups read small SQLite files; results are cached and only new or changed files are read later.
 */
export class ChatLinkResolver {
  private readonly readSdkSessionId: SdkSessionIdReader | undefined;
  private readonly readValue: SqliteValueReader | undefined;
  /** CLI session id → agent-host session id. */
  private readonly hostIds = new Map<string, string>();
  /** CLI session id → its agentSessionData folder name. */
  private readonly dataDirs = new Map<string, string>();
  private readonly scannedDirs = new Set<string>();
  /** CLI session id → when a scan last failed to find it, so lookups for it don't rescan on every call. */
  private readonly misses = new Map<string, number>();
  private scanning: Promise<void> | undefined;
  /** SQLite file → what was read from it, keyed by the file's modification time. */
  private readonly fileCache = new Map<string, { stamp: string; value: unknown }>();
  private index: { builtAt: number; entries: Map<string, ChatIndexEntry> } | undefined;
  /** Transcript workspace folders outside workspaceStorageRoots. */
  private readonly extraWorkspaceDirs = new Set<string>();

  constructor(private readonly options: ChatLinkOptions) {
    this.readSdkSessionId = "readSdkSessionId" in options ? options.readSdkSessionId : sqliteSdkSessionIdReader();
    this.readValue = "readValue" in options ? options.readValue : sqliteValueReader();
  }

  async resolve(info: SessionInfo): Promise<string | undefined> {
    if (info.source === "vscode") {
      const current = this.options.currentWorkspaceStorageDir;
      return current && info.workspaceStorageDir && samePath(info.workspaceStorageDir, current)
        ? vscodeChatSessionUri(info.id)
        : undefined;
    }
    const hostId = await this.hostIdOf(info);
    return hostId ? agentHostSessionUri(hostId) : undefined;
  }

  /** The title VS Code shows for this session, once it has named it. */
  async title(info: SessionInfo): Promise<string | undefined> {
    const read = this.readValue;
    if (!read) {
      return undefined;
    }
    const clean = (t: string | undefined) => {
      const s = t?.replace(/\s+/g, " ").trim();
      return s && s !== UNTITLED_CHAT ? s : undefined;
    };
    if (info.source === "vscode") {
      return clean(this.chatIndex(info.workspaceStorageDir).get(info.id)?.title);
    }
    const hostId = await this.hostIdOf(info);
    if (!hostId) {
      return undefined;
    }
    // The chat index holds the title the Sessions view shows; session.db's customTitle can lag behind it.
    const indexed = clean(this.chatIndex().get(`${AGENT_HOST_CHAT_PREFIX}${hostId}`)?.title);
    if (indexed) {
      return indexed;
    }
    const db = path.join(this.options.agentSessionDataDir!, this.dataDirs.get(info.id)!, "session.db");
    return clean(this.cached(db, (file) => read(file, "session_metadata", CUSTOM_TITLE_KEY)));
  }

  /**
   * Chat session id → title, merged from every workspace's chat index (a chat is indexed by the window that opened
   * it). Rebuilt at most every INDEX_TTL_MS, re-reading only the state.vscdb files that changed.
   */
  private chatIndex(extraDir?: string): Map<string, ChatIndexEntry> {
    const fresh = this.index && Date.now() - this.index.builtAt < INDEX_TTL_MS;
    if (extraDir && !this.extraWorkspaceDirs.has(extraDir)) {
      this.extraWorkspaceDirs.add(extraDir);
    } else if (fresh) {
      return this.index!.entries;
    }
    const dirs = new Set(this.extraWorkspaceDirs);
    for (const root of this.options.workspaceStorageRoots ?? []) {
      for (const name of readdirSafe(root)) {
        dirs.add(path.join(root, name));
      }
    }
    const entries = new Map<string, ChatIndexEntry>();
    for (const dir of dirs) {
      const titles = this.cached(path.join(dir, "state.vscdb"), (file) =>
        chatIndexEntries(this.readValue!(file, "ItemTable", CHAT_INDEX_KEY)),
      );
      for (const [id, entry] of titles ?? []) {
        const known = entries.get(id);
        if (!known || entry.lastMessageDate > known.lastMessageDate) {
          entries.set(id, entry);
        }
      }
    }
    this.index = { builtAt: Date.now(), entries };
    return entries;
  }

  private async hostIdOf(info: SessionInfo): Promise<string | undefined> {
    if (info.clientName !== AGENT_HOST_CLIENT || !this.options.agentSessionDataDir || !this.readSdkSessionId) {
      return undefined;
    }
    if (!this.hostIds.has(info.id)) {
      const missedAt = this.misses.get(info.id);
      if (missedAt !== undefined && Date.now() - missedAt < MISS_RETRY_MS) {
        return undefined;
      }
      await this.scan(info.id);
      if (!this.hostIds.has(info.id)) {
        this.misses.set(info.id, Date.now());
      }
    }
    return this.hostIds.get(info.id);
  }

  /** Re-reads a SQLite file only after it (or its write-ahead log) changed. */
  private cached<T>(file: string, read: (file: string) => T): T | undefined {
    const stamp = [file, `${file}-wal`].map((f) => fs.statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? 0).join(":");
    if (stamp.startsWith("0:")) {
      return undefined;
    }
    const hit = this.fileCache.get(file);
    if (hit?.stamp === stamp) {
      return hit.value as T;
    }
    const value = read(file);
    this.fileCache.set(file, { stamp, value });
    return value;
  }

  private async scan(wanted: string): Promise<void> {
    while (this.scanning) {
      await this.scanning;
      if (this.hostIds.has(wanted)) {
        return;
      }
    }
    this.scanning = this.scanNewDirs(wanted);
    try {
      await this.scanning;
    } finally {
      this.scanning = undefined;
    }
  }

  /** Reads folders not seen before, newest first, stopping once `wanted` is found. */
  private async scanNewDirs(wanted: string): Promise<void> {
    const root = this.options.agentSessionDataDir!;
    const read = this.readSdkSessionId!;
    let names: string[];
    try {
      names = await fs.promises.readdir(root);
    } catch {
      return;
    }
    const fresh: { name: string; hostId: string; mtimeMs: number }[] = [];
    for (const name of names) {
      if (this.scannedDirs.has(name)) {
        continue;
      }
      const hostId = hostSessionIdFromDataDir(name);
      if (!hostId) {
        this.scannedDirs.add(name);
        continue;
      }
      const stat = await fs.promises.stat(path.join(root, name)).catch(() => undefined);
      fresh.push({ name, hostId, mtimeMs: stat?.mtimeMs ?? 0 });
    }
    fresh.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (let i = 0; i < fresh.length; i++) {
      const { name, hostId } = fresh[i];
      const db = path.join(root, name, "session.db");
      if (!fs.existsSync(db)) {
        // Not written yet; try again on a later lookup.
        continue;
      }
      const sdkId = read(db);
      if (!sdkId) {
        // Locked or not populated yet; retry on a later lookup.
        continue;
      }
      this.scannedDirs.add(name);
      if (!this.hostIds.has(sdkId)) {
        this.hostIds.set(sdkId, hostId);
        this.dataDirs.set(sdkId, name);
      }
      if (sdkId === wanted) {
        return;
      }
      if (i % 25 === 24) {
        // node:sqlite is synchronous; let the extension host breathe during a first full scan.
        await new Promise((r) => setImmediate(r));
      }
    }
  }
}

type ChatIndexEntry = { title: string; lastMessageDate: number };

/** Session id → title from VS Code's chat session index (a JSON value in state.vscdb). */
function chatIndexEntries(json: string | undefined): Map<string, ChatIndexEntry> {
  const titles = new Map<string, ChatIndexEntry>();
  try {
    const entries: unknown = JSON.parse(json ?? "null")?.entries;
    for (const [id, entry] of Object.entries(entries ?? {})) {
      const { title, lastMessageDate } = (entry ?? {}) as { title?: unknown; lastMessageDate?: unknown };
      if (typeof title === "string") {
        titles.set(id, { title, lastMessageDate: typeof lastMessageDate === "number" ? lastMessageDate : 0 });
      }
    }
  } catch {
    // Missing or not the expected shape.
  }
  return titles;
}

function readdirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" || process.platform === "darwin"
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
}
