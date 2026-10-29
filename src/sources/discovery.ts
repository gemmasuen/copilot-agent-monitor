import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { truncate } from "../model/format";
import { SessionSource } from "../model/snapshot";

export interface SessionInfo {
  /** Unique key across sources. */
  key: string;
  id: string;
  source: SessionSource;
  file: string;
  title: string;
  cwd?: string;
  mtimeMs: number;
  sizeBytes: number;
  /** Copilot sessions: the harness that wrote it (`client_name` in workspace.yaml), e.g. "vscode-agent-host". */
  clientName?: string;
  /** VS Code transcripts: the workspaceStorage/<hash> folder the transcript belongs to. */
  workspaceStorageDir?: string;
}

export function defaultCopilotSessionStateDir(): string {
  return path.join(os.homedir(), ".copilot", "session-state");
}

/**
 * Per-platform VS Code user folders that may contain workspaceStorage.
 * Adapted from copilot-agent-viz (MIT, https://github.com/ilyas-it83/copilot-agent-viz); see NOTICE.
 */
export function vscodeWorkspaceStorageDirs(platform: NodeJS.Platform = os.platform()): string[] {
  const products = ["Code", "Code - Insiders"];
  let roots: string[];
  if (platform === "win32") {
    roots = [process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming")];
  } else if (platform === "darwin") {
    roots = [path.join(os.homedir(), "Library", "Application Support")];
  } else {
    roots = [process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")];
  }
  const dirs: string[] = [];
  for (const root of roots) {
    for (const product of products) {
      const dir = path.join(root, product, "User", "workspaceStorage");
      if (fs.existsSync(dir)) {
        dirs.push(dir);
      }
    }
  }
  return dirs;
}

async function safeStat(file: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.stat(file);
  } catch {
    return undefined;
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(dir);
  } catch {
    return [];
  }
}

async function readHead(file: string, bytes: number): Promise<string> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(file, "r");
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    await handle?.close();
  }
}

/** Reads `key: value` pairs from the simple workspace.yaml written by the Copilot harness. */
export function parseWorkspaceYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(line);
    if (!m) {
      continue;
    }
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value && value !== "|" && value !== ">") {
      out[m[1]] = value;
    }
  }
  return out;
}

export async function discoverCopilotSessions(stateDir: string, limit = 40): Promise<SessionInfo[]> {
  const candidates: SessionInfo[] = [];
  for (const name of await safeReaddir(stateDir)) {
    if (name.startsWith(".")) {
      continue;
    }
    const file = path.join(stateDir, name, "events.jsonl");
    const stat = await safeStat(file);
    if (!stat || !stat.isFile() || stat.size === 0) {
      continue;
    }
    candidates.push({
      key: `copilot:${name}`,
      id: name,
      source: "copilot",
      file,
      title: name,
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
    });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = candidates.slice(0, limit);
  await Promise.all(
    top.map(async (s) => {
      const yaml = parseWorkspaceYaml(await readHead(path.join(stateDir, s.id, "workspace.yaml"), 16 * 1024));
      s.cwd = yaml.cwd;
      s.clientName = yaml.client_name;
      const label = yaml.summary ?? yaml.name;
      const folder = s.cwd ? path.basename(s.cwd) : undefined;
      s.title = truncate(label, 90) ?? (folder ? `${folder} · ${s.id.slice(0, 8)}` : s.id);
    }),
  );
  return top;
}

export async function discoverVscodeTranscripts(storageDirs: string[], limit = 40): Promise<SessionInfo[]> {
  const candidates: (SessionInfo & { workspaceStorageDir: string })[] = [];
  for (const storage of storageDirs) {
    for (const ws of await safeReaddir(storage)) {
      const dir = path.join(storage, ws, "GitHub.copilot-chat", "transcripts");
      for (const f of await safeReaddir(dir)) {
        if (!f.endsWith(".jsonl")) {
          continue;
        }
        const file = path.join(dir, f);
        const stat = await safeStat(file);
        if (!stat || stat.size === 0) {
          continue;
        }
        const id = path.basename(f, ".jsonl");
        candidates.push({
          key: `vscode:${id}`,
          id,
          source: "vscode",
          file,
          title: id,
          mtimeMs: stat.mtimeMs,
          sizeBytes: stat.size,
          workspaceStorageDir: path.join(storage, ws),
        });
      }
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = candidates.slice(0, limit);
  await Promise.all(
    top.map(async (s) => {
      s.cwd = await readWorkspaceFolder(s.workspaceStorageDir);
      const prompt = firstUserPrompt(await readHead(s.file, 256 * 1024));
      const folder = s.cwd ? path.basename(s.cwd) : undefined;
      s.title = truncate(prompt, 90) ?? (folder ? `${folder} · ${s.id.slice(0, 8)}` : s.id);
    }),
  );
  return top;
}

async function readWorkspaceFolder(workspaceDir: string): Promise<string | undefined> {
  try {
    const json = JSON.parse(await fs.promises.readFile(path.join(workspaceDir, "workspace.json"), "utf8"));
    const uri: unknown = json.folder ?? json.workspace;
    if (typeof uri === "string") {
      return decodeURIComponent(uri.replace(/^file:\/\/\/?/, "")).replace(/^([a-z]):/i, (m) => m.toUpperCase());
    }
  } catch {
    // No workspace.json (empty window) or unreadable.
  }
  return undefined;
}

function firstUserPrompt(head: string): string | undefined {
  for (const line of head.split("\n")) {
    if (!line.includes('"user.message"')) {
      continue;
    }
    try {
      const e = JSON.parse(line);
      if (typeof e?.data?.content === "string") {
        return e.data.content;
      }
    } catch {
      // Possibly cut off at the head boundary.
    }
  }
  return undefined;
}
