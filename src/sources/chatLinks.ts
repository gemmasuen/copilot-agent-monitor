import * as fs from "fs";
import * as path from "path";
import type { SessionInfo } from "./discovery";

/*
 * Links that open a session's conversation in VS Code chat. Both formats are VS Code internals (checked against
 * VS Code 1.144), not public API, so a lookup that fails simply means "no link".
 *
 * - VS Code Local chat: vscode-chat-session://local/<base64url(sessionId)>. The transcript id is the chat session id.
 * - Copilot CLI run by VS Code's agent host (workspace.yaml `client_name: vscode-agent-host`): the agent host gives
 *   the session its own id. <userData>/agentSessionData/default-<base64url("copilotcli:/<hostId>")>/session.db maps
 *   it back to the CLI session id (session_metadata 'agentHost.chatProviderData' = {"sdkSessionId": ...}). VS Code
 *   opens agent-host-session://ahp-session/<hostId>.
 */

export const AGENT_HOST_CLIENT = "vscode-agent-host";
const DATA_DIR_PREFIX = "default-";
const COPILOT_CLI_PREFIX = "copilotcli:/";
const PROVIDER_DATA_KEY = "agentHost.chatProviderData";

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

export function sqliteSdkSessionIdReader(): SdkSessionIdReader | undefined {
  const mod = loadSqlite();
  if (!mod) {
    return undefined;
  }
  return (dbFile) => {
    let db: InstanceType<SqliteModule["DatabaseSync"]> | undefined;
    try {
      db = new mod.DatabaseSync(dbFile, { readOnly: true });
      const row = db.prepare("SELECT value FROM session_metadata WHERE key = ?").get(PROVIDER_DATA_KEY) as
        | { value?: unknown }
        | undefined;
      if (typeof row?.value !== "string") {
        return undefined;
      }
      const id: unknown = JSON.parse(row.value)?.sdkSessionId;
      return typeof id === "string" ? id : undefined;
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

export interface ChatLinkOptions {
  /** The running VS Code's agentSessionData folder; undefined disables agent-host links. */
  agentSessionDataDir?: string;
  /** This window's workspaceStorage/<hash> folder; undefined (empty window) disables VS Code Local links. */
  currentWorkspaceStorageDir?: string;
  /** Defaults to node:sqlite; undefined when it isn't available. */
  readSdkSessionId?: SdkSessionIdReader;
}

/**
 * Resolves sessions to links that open their conversation in this VS Code window.
 * Agent-host lookups read small SQLite files; results are cached and only new folders are read later.
 */
export class ChatLinkResolver {
  private readonly readSdkSessionId: SdkSessionIdReader | undefined;
  /** CLI session id → agent-host session id. */
  private readonly hostIds = new Map<string, string>();
  private readonly scannedDirs = new Set<string>();
  private scanning: Promise<void> | undefined;

  constructor(private readonly options: ChatLinkOptions) {
    this.readSdkSessionId = "readSdkSessionId" in options ? options.readSdkSessionId : sqliteSdkSessionIdReader();
  }

  async resolve(info: SessionInfo): Promise<string | undefined> {
    if (info.source === "vscode") {
      const current = this.options.currentWorkspaceStorageDir;
      return current && info.workspaceStorageDir && samePath(info.workspaceStorageDir, current)
        ? vscodeChatSessionUri(info.id)
        : undefined;
    }
    if (info.clientName !== AGENT_HOST_CLIENT || !this.options.agentSessionDataDir || !this.readSdkSessionId) {
      return undefined;
    }
    let hostId = this.hostIds.get(info.id);
    if (!hostId) {
      await this.scan(info.id);
      hostId = this.hostIds.get(info.id);
    }
    return hostId ? agentHostSessionUri(hostId) : undefined;
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

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" || process.platform === "darwin"
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
}
