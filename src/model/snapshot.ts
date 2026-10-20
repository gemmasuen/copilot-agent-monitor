/**
 * Serializable view model shared between the extension host and the webview.
 * Keep this file free of Node/VS Code imports.
 */

export type SessionSource = "copilot" | "vscode";

export type AgentStatus = "running" | "idle" | "done" | "failed";

/**
 * - spawn: a brand-new agent was created for the task
 * - reuse: a task was sent to an existing agent that had finished (idle)
 * - steer: a follow-up was sent to an agent that was still running
 * - peer:  a sub-agent messaged another sub-agent
 * - read:  the sender collected an agent's results
 */
export type TaskKind = "spawn" | "reuse" | "steer" | "peer" | "read";

export interface ToolView {
  name: string;
  title?: string;
  at: number;
  success?: boolean;
  durationMs?: number;
}

export interface AgentView {
  id: string;
  isMain: boolean;
  parentId: string | null;
  depth: number;
  name: string;
  agentType?: string;
  description?: string;
  model?: string;
  multiTurn: boolean;
  executionMode?: string;
  status: AgentStatus;
  statusText: string;
  createdAt: number;
  lastActivityAt: number;
  firstCompletedAt?: number;
  toolCalls: number;
  errors: number;
  tokens?: number;
  durationMs?: number;
  currentTool?: string;
  recentTools: ToolView[];
  /** Number of tasks this agent received after it had already finished once. */
  reuseCount: number;
  steerCount: number;
  /** Idle agents of the same type that could have been reused when this agent was created. */
  couldHaveReused: string[];
}

export interface TaskView {
  id: string;
  kind: TaskKind;
  fromAgentId: string;
  toAgentId: string;
  summary?: string;
  at: number;
  success?: boolean;
}

export type FeedKind = TaskKind | "complete" | "fail" | "user" | "session";

export interface FeedItem {
  id: string;
  at: number;
  kind: FeedKind;
  agentId?: string;
  text: string;
}

export interface StatusCounts {
  running: number;
  idle: number;
  done: number;
  failed: number;
}

export interface SessionSnapshot {
  sessionId: string;
  source: SessionSource;
  title: string;
  cwd?: string;
  startedAt?: number;
  ended: boolean;
  /** True when the harness keeps finished sub-agents alive for follow-ups. */
  supportsReuse: boolean;
  agents: AgentView[];
  tasks: TaskView[];
  feed: FeedItem[];
  /** Counts for sub-agents only (the main agent is excluded). */
  counts: StatusCounts;
  generatedAt: number;
  loading?: { bytesRead: number; totalBytes: number };
}
