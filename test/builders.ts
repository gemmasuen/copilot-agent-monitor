import { RawEvent } from "../src/model/events";

/** Builds events shaped like the real Copilot/VS Code JSONL logs (verified against local sessions). */
export class EventBuilder {
  readonly events: RawEvent[] = [];
  private t: number;
  private n = 0;

  constructor(start = Date.parse("2026-10-20T09:00:00.000Z")) {
    this.t = start;
  }

  get now(): number {
    return this.t;
  }

  advance(ms: number): this {
    this.t += ms;
    return this;
  }

  push(type: string, data: Record<string, any> = {}, agentId?: string): this {
    const e: RawEvent = { type, data, id: `e${++this.n}`, timestamp: new Date(this.t).toISOString(), parentId: null };
    if (agentId) {
      e.agentId = agentId;
    }
    this.events.push(e);
    return this;
  }

  sessionStart(model = "gpt-6-astra"): this {
    return this.push("session.start", {
      sessionId: "s1",
      startTime: new Date(this.t).toISOString(),
      selectedModel: model,
      context: { cwd: "D:\\repo" },
    });
  }

  toolStart(callId: string, toolName: string, args: Record<string, any> = {}, agentId?: string): this {
    return this.push("tool.execution_start", { toolCallId: callId, toolName, arguments: args }, agentId);
  }

  toolComplete(callId: string, success = true, result?: unknown, agentId?: string): this {
    return this.push("tool.execution_complete", { toolCallId: callId, success, result }, agentId);
  }

  /** `task` tool + subagent.started + subagent.configured, as emitted by the Copilot harness. */
  spawn(opts: {
    callId: string;
    agentId: string;
    name: string;
    type?: string;
    description?: string;
    by?: string;
    multiTurn?: boolean;
    mode?: "background" | "sync";
  }): this {
    const type = opts.type ?? "explore";
    const mode = opts.mode ?? "background";
    this.toolStart(
      opts.callId,
      "task",
      { name: opts.name, agent_type: type, description: opts.description ?? `do ${opts.name}`, mode, prompt: "secret prompt" },
      opts.by,
    );
    this.push(
      "subagent.started",
      {
        toolCallId: opts.callId,
        agentName: type,
        agentDisplayName: opts.name,
        agentDescription: opts.description ?? `do ${opts.name}`,
        model: "claude-sonnet-5",
        executionMode: mode,
      },
      opts.agentId,
    );
    this.push("subagent.configured", { model: "claude-sonnet-5", multiTurn: opts.multiTurn ?? true }, opts.agentId);
    if (mode === "background") {
      this.toolComplete(opts.callId, true, { content: `Agent started in background with agent_id: ${opts.agentId}.` }, opts.by);
    }
    return this;
  }

  agentWork(agentId: string, callId: string, tool = "grep"): this {
    this.push("assistant.turn_start", { turnId: "0" }, agentId);
    this.toolStart(callId, tool, { pattern: "foo" }, agentId);
    this.advance(500);
    this.toolComplete(callId, true, { content: "ok" }, agentId);
    this.push("assistant.turn_end", { turnId: "0" }, agentId);
    return this;
  }

  complete(agentId: string, callId: string, extra: Record<string, any> = {}): this {
    return this.push(
      "subagent.completed",
      { toolCallId: callId, totalToolCalls: 3, totalTokens: 12345, durationMs: 4000, ...extra },
      agentId,
    );
  }
}
