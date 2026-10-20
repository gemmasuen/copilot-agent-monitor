import type { SessionSnapshot, SessionSource } from "../model/snapshot";

export interface SessionOption {
  key: string;
  title: string;
  source: SessionSource;
  mtimeMs: number;
  cwd?: string;
}

export type ToWebview =
  | { type: "snapshot"; snapshot: SessionSnapshot | undefined }
  | { type: "sessions"; sessions: SessionOption[]; currentKey?: string; follow: boolean };

export type FromWebview =
  | { type: "ready" }
  | { type: "selectSession"; key: string }
  | { type: "setFollow"; follow: boolean }
  | { type: "reload" };
