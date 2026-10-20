/**
 * Minimal, tolerant view of the JSONL events written by:
 *  - Copilot CLI / Copilot SDK harness: ~/.copilot/session-state/<id>/events.jsonl
 *  - VS Code Local harness: workspaceStorage/<hash>/GitHub.copilot-chat/transcripts/<id>.jsonl
 *
 * Both formats are internal and undocumented, so every field is optional and
 * unknown event types are ignored.
 */
export interface RawEvent {
  type: string;
  data?: Record<string, any>;
  id?: string;
  timestamp?: string;
  parentId?: string | null;
  /** Present on events emitted inside a sub-agent (Copilot harness only). */
  agentId?: string;
}

export const RELEVANT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "session.start",
  "session.resume",
  "session.shutdown",
  "session.model_change",
  "user.message",
  "assistant.turn_start",
  "assistant.turn_end",
  "abort",
  "tool.execution_start",
  "tool.execution_complete",
  "subagent.started",
  "subagent.configured",
  "subagent.completed",
  "subagent.failed",
]);

const TYPE_AT_START = /^\s*\{\s*"type"\s*:\s*"([^"]+)"/;
const TYPE_ANYWHERE = /"type"\s*:\s*"([^"]+)"/;

/** Extracts the event type from the first bytes of a line without parsing the whole line. */
export function peekEventType(linePrefix: string): string | undefined {
  const m = TYPE_AT_START.exec(linePrefix) ?? TYPE_ANYWHERE.exec(linePrefix);
  return m?.[1];
}

export function isRelevantType(type: string | undefined): boolean {
  return type !== undefined && RELEVANT_EVENT_TYPES.has(type);
}

export function parseEventLine(line: string): RawEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const value = JSON.parse(trimmed);
    if (value && typeof value === "object" && typeof value.type === "string") {
      return value as RawEvent;
    }
  } catch {
    // Malformed or partially written line.
  }
  return undefined;
}

export function eventTime(e: RawEvent, fallback: number): number {
  if (e.timestamp) {
    const t = Date.parse(e.timestamp);
    if (!Number.isNaN(t)) {
      return t;
    }
  }
  return fallback;
}
