import { truncate } from "./model/format";
import { OrchestrationModel } from "./model/orchestration";
import { SessionSnapshot } from "./model/snapshot";
import { SessionInfo, discoverCopilotSessions, discoverVscodeTranscripts } from "./sources/discovery";
import { JsonlTailer } from "./sources/jsonlTail";
import type { SessionOption } from "./webview/messages";

export interface MonitorConfig {
  copilotSessions: boolean;
  vscodeTranscripts: boolean;
  copilotStateDir: string;
  vscodeStorageDirs: string[];
  showPreviews: boolean;
}

export interface MonitorTimings {
  pollMs: number;
  discoverMs: number;
  /** Follow mode only leaves the current session after it has been quiet this long. */
  followQuietMs: number;
  emitThrottleMs: number;
}

export const DEFAULT_TIMINGS: MonitorTimings = {
  pollMs: 700,
  discoverMs: 5000,
  followQuietMs: 20_000,
  emitThrottleMs: 250,
};

export interface Disposable {
  dispose(): void;
}

class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>();
  readonly event = (listener: (value: T) => void): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value: T): void {
    for (const l of [...this.listeners]) {
      l(value);
    }
  }
}

interface CurrentSession {
  info: SessionInfo;
  model: OrchestrationModel;
  tailer: JsonlTailer;
  loading?: { bytesRead: number; totalBytes: number };
}

/**
 * Discovers sessions, follows the active one, tails its log and publishes snapshots.
 * Free of VS Code APIs so it can be unit tested.
 */
export class MonitorController implements Disposable {
  follow = true;
  private sessions: SessionInfo[] = [];
  private current: CurrentSession | undefined;
  private loadToken = 0;
  private timers: ReturnType<typeof setInterval>[] = [];
  private polling = false;
  private discovering = false;
  private wasLive = false;
  private lastEmitAt = 0;
  private lastSnapshotKey = "";
  private emitTimer: ReturnType<typeof setTimeout> | undefined;
  private sessionsSignature = "";
  private readonly snapshotEmitter = new Emitter<SessionSnapshot | undefined>();
  private readonly sessionsEmitter = new Emitter<void>();
  readonly onDidChangeSnapshot = this.snapshotEmitter.event;
  readonly onDidChangeSessions = this.sessionsEmitter.event;

  constructor(
    private config: MonitorConfig,
    private readonly timings: MonitorTimings = DEFAULT_TIMINGS,
    private readonly now: () => number = Date.now,
    /** Looks up the title VS Code shows for a session; undefined keeps the title from the session files. */
    private readonly titleOf?: (info: SessionInfo) => Promise<string | undefined>,
  ) {}

  get currentKey(): string | undefined {
    return this.current?.info.key;
  }

  get currentInfo(): SessionInfo | undefined {
    return this.current?.info;
  }

  get isLoading(): boolean {
    return this.current?.loading !== undefined;
  }

  async start(): Promise<void> {
    this.timers.push(
      setInterval(() => void this.discover(), this.timings.discoverMs),
      setInterval(() => void this.poll(), this.timings.pollMs),
    );
    await this.discover();
  }

  async updateConfig(config: MonitorConfig): Promise<void> {
    const previous = this.config;
    this.config = config;
    if (previous.showPreviews !== config.showPreviews) {
      await this.reload();
    }
    if (
      previous.copilotSessions !== config.copilotSessions ||
      previous.vscodeTranscripts !== config.vscodeTranscripts ||
      previous.copilotStateDir !== config.copilotStateDir
    ) {
      const src = this.current?.info.source;
      if ((src === "copilot" && !config.copilotSessions) || (src === "vscode" && !config.vscodeTranscripts)) {
        this.close();
      }
      await this.discover();
    }
  }

  sessionOptions(): SessionOption[] {
    return this.sessions.map((s) => ({ key: s.key, title: s.title, source: s.source, mtimeMs: s.mtimeMs, cwd: s.cwd }));
  }

  sessionInfos(): readonly SessionInfo[] {
    return this.sessions;
  }

  snapshot(): SessionSnapshot | undefined {
    const cur = this.current;
    if (!cur) {
      return undefined;
    }
    const snap = cur.model.snapshot(this.now());
    if (cur.loading) {
      snap.loading = { ...cur.loading };
    }
    return snap;
  }

  async discover(): Promise<void> {
    if (this.discovering) {
      return;
    }
    this.discovering = true;
    try {
      const cfg = this.config;
      const lists = await Promise.all([
        cfg.copilotSessions ? discoverCopilotSessions(cfg.copilotStateDir) : Promise.resolve([]),
        cfg.vscodeTranscripts ? discoverVscodeTranscripts(cfg.vscodeStorageDirs) : Promise.resolve([]),
      ]);
      const merged = lists.flat().sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 60);
      if (this.titleOf) {
        // Prefer the title VS Code shows for the session over its first prompt.
        await Promise.all(
          merged.map(async (s) => {
            const title = await this.titleOf!(s).catch(() => undefined);
            s.title = truncate(title, 90) ?? s.title;
          }),
        );
      }
      this.sessions = merged;
      const cur = this.current;
      const renamed = cur && merged.find((s) => s.key === cur.info.key && s.title !== cur.model.title);
      if (cur && renamed) {
        cur.info.title = renamed.title;
        cur.model.title = renamed.title;
        this.emitSnapshot(true);
      }
      const signature = merged.map((s) => `${s.key}|${s.title}`).join("\n");
      if (signature !== this.sessionsSignature) {
        this.sessionsSignature = signature;
        this.sessionsEmitter.fire();
      }
      if (this.follow) {
        await this.maybeFollow(false);
      } else if (!this.current && merged.length > 0) {
        await this.open(merged[0]);
      }
    } finally {
      this.discovering = false;
    }
  }

  async selectSession(key: string): Promise<void> {
    const info = this.sessions.find((s) => s.key === key);
    if (!info) {
      return;
    }
    this.follow = false;
    this.sessionsEmitter.fire();
    if (info.key !== this.current?.info.key) {
      await this.open(info);
    }
  }

  setFollow(follow: boolean): void {
    this.follow = follow;
    this.sessionsEmitter.fire();
    if (follow) {
      void this.maybeFollow(true);
    }
  }

  async reload(): Promise<void> {
    if (this.current) {
      await this.open(this.current.info);
    }
  }

  async poll(): Promise<void> {
    const cur = this.current;
    if (!cur || cur.loading || this.polling) {
      return;
    }
    this.polling = true;
    try {
      const result = await cur.tailer.readNew();
      if (cur !== this.current) {
        return;
      }
      if (result.reset) {
        await this.open(cur.info);
        return;
      }
      for (const e of result.events) {
        cur.model.apply(e);
      }
      const live = cur.model.isLive(this.now());
      if (result.events.length > 0 || live || this.wasLive) {
        this.emitSnapshot(false);
      }
      this.wasLive = live;
    } finally {
      this.polling = false;
    }
  }

  private async maybeFollow(explicit: boolean): Promise<void> {
    const newest = this.sessions[0];
    if (!newest) {
      return;
    }
    const cur = this.current;
    if (!cur) {
      await this.open(newest);
      return;
    }
    if (newest.key === cur.info.key) {
      return;
    }
    if (explicit) {
      await this.open(newest);
      return;
    }
    const listed = this.sessions.find((s) => s.key === cur.info.key);
    const currentMtime = listed?.mtimeMs ?? 0;
    const currentQuiet = this.now() - currentMtime > this.timings.followQuietMs;
    if (currentQuiet && newest.mtimeMs > currentMtime) {
      await this.open(newest);
    }
  }

  private async open(info: SessionInfo): Promise<void> {
    const token = ++this.loadToken;
    const model = new OrchestrationModel(info.id, info.source, info.title, { showPreviews: this.config.showPreviews });
    const tailer = new JsonlTailer(info.file);
    const cur: CurrentSession = { info, model, tailer, loading: { bytesRead: 0, totalBytes: info.sizeBytes } };
    this.current = cur;
    this.wasLive = false;
    this.lastSnapshotKey = "";
    this.sessionsEmitter.fire();
    this.emitSnapshot(true);
    try {
      await tailer.readNew(
        (events, position, size) => {
          for (const e of events) {
            model.apply(e);
          }
          cur.loading = { bytesRead: position, totalBytes: size };
          this.emitSnapshot(false);
        },
        () => token !== this.loadToken,
      );
    } catch {
      // Unreadable file: show whatever was parsed.
    }
    if (token !== this.loadToken) {
      return;
    }
    cur.loading = undefined;
    this.emitSnapshot(true);
  }

  private close(): void {
    this.loadToken++;
    this.current = undefined;
    this.emitSnapshot(true);
  }

  private emitSnapshot(force: boolean): void {
    const elapsed = this.now() - this.lastEmitAt;
    if (!force && elapsed < this.timings.emitThrottleMs) {
      if (!this.emitTimer) {
        this.emitTimer = setTimeout(() => {
          this.emitTimer = undefined;
          this.emitSnapshot(false);
        }, this.timings.emitThrottleMs - elapsed);
      }
      return;
    }
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = undefined;
    }
    const snap = this.snapshot();
    const key = snap ? JSON.stringify({ ...snap, generatedAt: 0 }) : "";
    if (!force && key === this.lastSnapshotKey) {
      return;
    }
    this.lastSnapshotKey = key;
    this.lastEmitAt = this.now();
    this.snapshotEmitter.fire(snap);
  }

  dispose(): void {
    this.loadToken++;
    for (const t of this.timers) {
      clearInterval(t);
    }
    this.timers = [];
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
    }
  }
}
