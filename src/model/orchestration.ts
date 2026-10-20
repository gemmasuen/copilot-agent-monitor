import { RawEvent, eventTime } from "./events";
import { formatDuration, formatTokens, truncate } from "./format";
import {
  AgentStatus,
  AgentView,
  FeedItem,
  FeedKind,
  SessionSnapshot,
  SessionSource,
  StatusCounts,
  TaskKind,
  TaskView,
  ToolView,
} from "./snapshot";

export const MAIN_AGENT_ID = "main";

const MAX_RECENT_TOOLS = 12;
const MAX_FEED = 400;
const MAX_TASKS = 3000;
/** The main agent is shown as running for a short while after its last event. */
const MAIN_QUIET_MS = 4_000;
/** A reused sub-agent emits no second `subagent.completed`; treat it as idle after this much silence. */
const SUB_QUIET_MS = 6_000;
/** After a task is delivered to an idle agent, show it as running until it starts a turn. */
const DELIVERY_GRACE_MS = 60_000;
/** A never-completed agent with no open work and no events for this long is considered stopped. */
const STALE_MS = 15 * 60_000;
/** Open turns/tools older than this are assumed to be lost (e.g. a crash). */
const BUSY_STALE_MS = 2 * 60 * 60_000;

/** VS Code Local harness sub-agent tools: runSubagent, execution_subagent, search_subagent, ... */
const VSCODE_SUBAGENT_TOOL = /subagent/i;
const COPILOT_SPAWN_TOOL = "task";
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export interface ModelOptions {
  /** Include truncated task descriptions / messages in the view model. */
  showPreviews: boolean;
}

interface RecentTool extends ToolView {
  callId: string;
}

interface AgentState {
  id: string;
  isMain: boolean;
  parentId: string | null;
  name: string;
  agentType?: string;
  description?: string;
  model?: string;
  multiTurn: boolean;
  executionMode?: string;
  createdAt: number;
  lastActivityAt: number;
  firstCompletedAt?: number;
  lastCompletedAt?: number;
  failed: boolean;
  /** Set when the session ended/restarted, so the agent no longer exists. */
  disposed: boolean;
  openTurns: number;
  pendingTools: Map<string, string>;
  pendingDeliveryAt?: number;
  toolCalls: number;
  reportedToolCalls?: number;
  errors: number;
  tokens?: number;
  durationMs?: number;
  recentTools: RecentTool[];
  reuseCount: number;
  steerCount: number;
  couldHaveReused: string[];
}

interface ToolCallInfo {
  name: string;
  by: string;
  at: number;
  args: Record<string, any>;
}

export class OrchestrationModel {
  private readonly agents = new Map<string, AgentState>();
  private readonly toolCalls = new Map<string, ToolCallInfo>();
  private readonly spawnedByCall = new Map<string, string>();
  private readonly deferredWrites = new Map<string, ToolCallInfo>();
  private tasks: TaskView[] = [];
  private feed: FeedItem[] = [];
  private ended = false;
  private startedAt?: number;
  private cwd?: string;
  private lastEventAt = 0;
  private seq = 0;
  private sawSubagentLifecycle = false;

  constructor(
    readonly sessionId: string,
    readonly source: SessionSource,
    public title: string,
    private readonly options: ModelOptions = { showPreviews: true },
  ) {
    this.agents.set(MAIN_AGENT_ID, this.newAgent(MAIN_AGENT_ID, null, "Main agent", 0, true));
  }

  get eventCount(): number {
    return this.seq;
  }

  apply(e: RawEvent): void {
    this.seq++;
    const at = eventTime(e, this.lastEventAt || Date.now());
    this.lastEventAt = Math.max(this.lastEventAt, at);
    const d = e.data ?? {};
    const main = this.agents.get(MAIN_AGENT_ID)!;
    if (main.createdAt === 0) {
      main.createdAt = at;
    }

    switch (e.type) {
      case "session.start": {
        const start = Date.parse(d.startTime ?? "");
        this.startedAt = Number.isNaN(start) ? at : start;
        main.createdAt = Math.min(main.createdAt, this.startedAt);
        this.cwd = d.context?.cwd ?? d.cwd ?? this.cwd;
        main.model = d.selectedModel ?? main.model;
        this.touch(main, at);
        this.pushFeed("session", at, "Session started", MAIN_AGENT_ID);
        return;
      }
      case "session.resume": {
        if (this.ended) {
          this.disposeSubagents();
          this.pushFeed("session", at, "Session resumed — earlier sub-agents no longer exist", MAIN_AGENT_ID);
        }
        this.ended = false;
        this.touch(main, at);
        return;
      }
      case "session.shutdown": {
        this.ended = true;
        this.disposeSubagents();
        main.openTurns = 0;
        main.pendingTools.clear();
        this.pushFeed("session", at, "Session ended", MAIN_AGENT_ID);
        return;
      }
      case "session.model_change": {
        main.model = d.newModel ?? d.model ?? d.selectedModel ?? main.model;
        return;
      }
      case "subagent.started":
        this.onSubagentStarted(e, at);
        return;
      case "subagent.configured": {
        const agent = this.agentFor(e.agentId, at);
        if (agent && !agent.isMain) {
          agent.multiTurn = Boolean(d.multiTurn);
          agent.model = d.model ?? agent.model;
        }
        return;
      }
      case "subagent.completed":
        this.onSubagentCompleted(e, at);
        return;
      case "subagent.failed": {
        const agent = this.agentFor(e.agentId, at);
        if (agent && !agent.isMain) {
          agent.failed = true;
          agent.openTurns = 0;
          agent.pendingTools.clear();
          this.touch(agent, at);
          const reason = truncate(d.error ?? d.message, 120);
          this.pushFeed("fail", at, `“${agent.name}” failed${reason ? `: ${reason}` : ""}`, agent.id);
        }
        return;
      }
    }

    const actor = this.agentFor(e.agentId, at) ?? main;

    switch (e.type) {
      case "user.message": {
        this.touch(actor, at);
        if (actor.isMain) {
          const preview = this.options.showPreviews ? truncate(d.content, 140) : undefined;
          this.pushFeed("user", at, preview ? `You: ${preview}` : "You sent a prompt", MAIN_AGENT_ID);
        }
        return;
      }
      case "assistant.turn_start":
        actor.openTurns++;
        actor.pendingDeliveryAt = undefined;
        this.touch(actor, at);
        return;
      case "assistant.turn_end":
        actor.openTurns = Math.max(0, actor.openTurns - 1);
        this.touch(actor, at);
        return;
      case "abort":
        actor.openTurns = 0;
        actor.pendingTools.clear();
        this.touch(actor, at);
        return;
      case "tool.execution_start":
        this.onToolStart(actor, d, at);
        return;
      case "tool.execution_complete":
        this.onToolComplete(d, at);
        return;
    }
  }

  snapshot(now: number = Date.now()): SessionSnapshot {
    const counts: StatusCounts = { running: 0, idle: 0, done: 0, failed: 0 };
    const agents: AgentView[] = [];
    const ordered = [...this.agents.values()].sort((a, b) =>
      a.isMain ? -1 : b.isMain ? 1 : a.createdAt - b.createdAt,
    );
    for (const a of ordered) {
      const status = this.statusOf(a, now);
      if (!a.isMain) {
        counts[status]++;
      }
      agents.push({
        id: a.id,
        isMain: a.isMain,
        parentId: a.parentId,
        depth: this.depthOf(a),
        name: a.name,
        agentType: a.agentType,
        description: this.options.showPreviews ? a.description : undefined,
        model: a.model,
        multiTurn: a.multiTurn,
        executionMode: a.executionMode,
        status,
        statusText: this.statusText(a, status, now),
        createdAt: a.createdAt,
        lastActivityAt: a.lastActivityAt,
        firstCompletedAt: a.firstCompletedAt,
        toolCalls: Math.max(a.toolCalls, a.reportedToolCalls ?? 0),
        errors: a.errors,
        tokens: a.tokens,
        durationMs: a.durationMs,
        currentTool: status === "running" ? this.currentTool(a) : undefined,
        recentTools: a.recentTools.map(({ callId: _ignored, ...t }) => t),
        reuseCount: a.reuseCount,
        steerCount: a.steerCount,
        couldHaveReused: [...a.couldHaveReused],
      });
    }
    return {
      sessionId: this.sessionId,
      source: this.source,
      title: this.title,
      cwd: this.cwd,
      startedAt: this.startedAt,
      ended: this.ended,
      supportsReuse: this.source === "copilot" || this.sawSubagentLifecycle,
      agents,
      tasks: [...this.tasks],
      feed: [...this.feed],
      counts,
      generatedAt: now,
    };
  }

  /** True while any agent may change status purely due to the passage of time. */
  isLive(now: number = Date.now()): boolean {
    if (this.ended) {
      return false;
    }
    for (const a of this.agents.values()) {
      if (this.statusOf(a, now) === "running") {
        return true;
      }
    }
    return false;
  }

  private onSubagentStarted(e: RawEvent, at: number): void {
    const d = e.data ?? {};
    this.sawSubagentLifecycle = true;
    const agentId = e.agentId ?? d.agentId ?? d.toolCallId;
    if (!agentId) {
      return;
    }
    const callId: string | undefined = d.toolCallId;
    const call = callId ? this.toolCalls.get(callId) : undefined;
    const args = call?.args ?? {};
    const parentId = call && this.agents.has(call.by) ? call.by : MAIN_AGENT_ID;
    const agentType: string | undefined = d.agentName ?? args.agent_type;
    const name: string = d.agentDisplayName ?? args.name ?? agentType ?? `agent ${agentId.slice(0, 8)}`;
    const description: string | undefined = truncate(d.agentDescription ?? args.description, 160);

    let agent = this.agents.get(agentId);
    const isNew = !agent;
    if (!agent) {
      agent = this.newAgent(agentId, parentId, name, at, false);
      agent.couldHaveReused = this.reusableCandidates(parentId, agentType, at, agentId);
      this.agents.set(agentId, agent);
    }
    agent.parentId = parentId;
    agent.name = name;
    agent.agentType = agentType;
    agent.description = description ?? agent.description;
    agent.model = d.model ?? agent.model;
    agent.executionMode = d.executionMode ?? args.mode ?? agent.executionMode;
    this.touch(agent, at);
    if (callId) {
      this.spawnedByCall.set(callId, agentId);
    }
    if (!isNew) {
      return;
    }

    const parent = this.agents.get(parentId)!;
    this.pushTask({
      id: callId ?? `spawn:${agentId}`,
      kind: "spawn",
      fromAgentId: parentId,
      toAgentId: agentId,
      summary: this.preview(description),
      at,
    });
    const typeLabel = agentType && agentType !== name ? `${agentType} ` : "";
    let text = `${this.label(parent)} created a new ${typeLabel}agent “${name}”`;
    const what = this.preview(description);
    if (what) {
      text += `: ${what}`;
    }
    if (agent.couldHaveReused.length > 0) {
      const others = agent.couldHaveReused.map((id) => `“${this.agents.get(id)?.name ?? id}”`).join(", ");
      text += ` — instead of reusing idle ${others}`;
    }
    this.pushFeed("spawn", at, text, agentId);
  }

  private onSubagentCompleted(e: RawEvent, at: number): void {
    const d = e.data ?? {};
    const agent = this.agentFor(e.agentId, at);
    if (!agent || agent.isMain) {
      return;
    }
    agent.openTurns = 0;
    agent.pendingTools.clear();
    agent.pendingDeliveryAt = undefined;
    agent.firstCompletedAt ??= at;
    agent.lastCompletedAt = at;
    agent.tokens = typeof d.totalTokens === "number" ? d.totalTokens : agent.tokens;
    agent.durationMs = typeof d.durationMs === "number" ? d.durationMs : agent.durationMs;
    if (typeof d.totalToolCalls === "number") {
      agent.reportedToolCalls = d.totalToolCalls;
    }
    agent.model = d.model ?? agent.model;
    this.touch(agent, at);
    const stats = `${Math.max(agent.toolCalls, agent.reportedToolCalls ?? 0)} tools, ${formatDuration(agent.durationMs)}, ${formatTokens(agent.tokens)} tokens`;
    const after = agent.multiTurn ? "now idle and can be reused" : "done";
    this.pushFeed("complete", at, `“${agent.name}” finished (${stats}) — ${after}`, agent.id);
  }

  private onToolStart(actor: AgentState, d: Record<string, any>, at: number): void {
    const callId: string = d.toolCallId ?? `call-${this.seq}`;
    const name: string = d.toolName ?? "tool";
    const args = normalizeArgs(d.arguments);
    actor.toolCalls++;
    actor.pendingTools.set(callId, name);
    actor.recentTools.push({ callId, name, title: this.toolTitle(args), at });
    if (actor.recentTools.length > MAX_RECENT_TOOLS) {
      actor.recentTools.shift();
    }
    this.touch(actor, at);
    const info: ToolCallInfo = { name, by: actor.id, at, args };
    this.toolCalls.set(callId, info);

    if (name === COPILOT_SPAWN_TOOL) {
      return; // The agent node is created on `subagent.started`.
    }
    if (VSCODE_SUBAGENT_TOOL.test(name)) {
      this.spawnStatelessSubagent(callId, actor, name, args, at);
      return;
    }
    if (name === "write_agent") {
      const targets = explicitTargets(args);
      if (targets.length === 0) {
        this.deferredWrites.set(callId, info);
        return;
      }
      for (const target of targets) {
        this.addMessageTask(callId, actor, target, args.message, at, targets.length > 1);
      }
      return;
    }
    if (name === "read_agent" && typeof args.agent_id === "string") {
      this.addReadTask(callId, actor, args.agent_id, at);
    }
  }

  private onToolComplete(d: Record<string, any>, at: number): void {
    const callId: string | undefined = d.toolCallId;
    const call = callId ? this.toolCalls.get(callId) : undefined;
    if (!callId || !call) {
      return;
    }
    this.toolCalls.delete(callId);
    const success = d.success !== false;
    const by = this.agents.get(call.by);
    if (by) {
      by.pendingTools.delete(callId);
      if (!success) {
        by.errors++;
      }
      const recent = by.recentTools.find((t) => t.callId === callId);
      if (recent) {
        recent.success = success;
        recent.durationMs = Math.max(0, at - call.at);
      }
      this.touch(by, at);
    }

    if (call.name === COPILOT_SPAWN_TOOL && !this.spawnedByCall.has(callId)) {
      if (!success) {
        this.addFailedSpawn(callId, call, d, at);
      }
      return;
    }
    if (VSCODE_SUBAGENT_TOOL.test(call.name)) {
      const agent = this.agents.get(callId);
      if (agent) {
        agent.firstCompletedAt = at;
        agent.lastCompletedAt = at;
        agent.durationMs = Math.max(0, at - call.at);
        agent.failed = !success;
        agent.openTurns = 0;
        this.touch(agent, at);
        this.pushFeed(
          success ? "complete" : "fail",
          at,
          success
            ? `“${agent.name}” finished (${formatDuration(agent.durationMs)}) — done (VS Code sub-agents can’t be reused)`
            : `“${agent.name}” failed`,
          agent.id,
        );
      }
      return;
    }
    const deferred = this.deferredWrites.get(callId);
    if (deferred) {
      this.deferredWrites.delete(callId);
      const sender = this.agents.get(deferred.by);
      if (sender && success) {
        const recipients = this.resolveRecipients(deferred, d, sender);
        for (const target of recipients) {
          this.addMessageTask(callId, sender, target, deferred.args.message, deferred.at, recipients.length > 1);
        }
      }
    }
  }

  private spawnStatelessSubagent(
    callId: string,
    parent: AgentState,
    toolName: string,
    args: Record<string, any>,
    at: number,
  ): void {
    const description = truncate(args.description ?? args.query, 160);
    const agentType: string = args.agentName ?? (toolName.replace(/_?subagent$/i, "") || "subagent");
    const name: string = args.agentName ?? description ?? toolName;
    const agent = this.newAgent(callId, parent.id, name, at, false);
    agent.agentType = agentType;
    agent.description = description;
    agent.executionMode = "sync";
    agent.model = typeof args.model === "string" ? args.model : undefined;
    this.agents.set(callId, agent);
    this.spawnedByCall.set(callId, callId);
    this.pushTask({
      id: callId,
      kind: "spawn",
      fromAgentId: parent.id,
      toAgentId: callId,
      summary: this.preview(description),
      at,
    });
    const what = this.preview(description);
    this.pushFeed(
      "spawn",
      at,
      `${this.label(parent)} created a new ${agentType} agent${args.agentName ? ` “${name}”` : ""}${what ? `: ${what}` : ""}`,
      callId,
    );
  }

  private addFailedSpawn(callId: string, call: ToolCallInfo, d: Record<string, any>, at: number): void {
    const args = call.args;
    const name: string = args.name ?? args.agent_type ?? "sub-agent";
    const agent = this.newAgent(callId, call.by, name, call.at, false);
    agent.agentType = args.agent_type;
    agent.description = truncate(args.description, 160);
    agent.failed = true;
    agent.firstCompletedAt = at;
    agent.lastCompletedAt = at;
    this.agents.set(callId, agent);
    this.spawnedByCall.set(callId, callId);
    this.pushTask({
      id: callId,
      kind: "spawn",
      fromAgentId: call.by,
      toAgentId: callId,
      summary: this.preview(agent.description),
      at: call.at,
      success: false,
    });
    const reason = truncate(d.error?.message ?? d.result?.content, 120);
    this.pushFeed("fail", at, `Could not start “${name}”${reason ? `: ${reason}` : ""}`, callId);
  }

  private addMessageTask(
    callId: string,
    from: AgentState,
    targetId: string,
    message: unknown,
    at: number,
    multi: boolean,
  ): void {
    if (targetId === from.id) {
      return;
    }
    const target = this.agentFor(targetId, at, from.id)!;
    let kind: TaskKind;
    if (!from.isMain && target.parentId !== from.id) {
      kind = "peer";
    } else {
      kind = this.statusOf(target, at) === "running" ? "steer" : "reuse";
    }
    if (kind === "reuse") {
      target.reuseCount++;
      target.pendingDeliveryAt = at;
    } else if (kind === "steer") {
      target.steerCount++;
    }
    const summary = this.preview(truncate(message, 160));
    this.pushTask({
      id: multi ? `${callId}:${targetId}` : callId,
      kind,
      fromAgentId: from.id,
      toAgentId: target.id,
      summary,
      at,
    });
    const suffix = summary ? `: ${summary}` : "";
    const text =
      kind === "reuse"
        ? `${this.label(from)} reused idle agent “${target.name}” for a new task${suffix}`
        : kind === "steer"
          ? `${this.label(from)} sent a follow-up to running agent “${target.name}”${suffix}`
          : `${this.label(from)} → “${target.name}”${suffix}`;
    this.pushFeed(kind, at, text, target.id);
  }

  private addReadTask(callId: string, from: AgentState, targetId: string, at: number): void {
    const target = this.agents.get(targetId);
    if (!target) {
      return;
    }
    this.pushTask({ id: callId, kind: "read", fromAgentId: from.id, toAgentId: target.id, at });
    const last = this.feed[this.feed.length - 1];
    if (last && last.kind === "read" && last.agentId === target.id && at - last.at < 60_000) {
      return;
    }
    this.pushFeed("read", at, `${this.label(from)} collected results from “${target.name}”`, target.id);
  }

  private resolveRecipients(call: ToolCallInfo, d: Record<string, any>, sender: AgentState): string[] {
    const content = typeof d.result === "string" ? d.result : d.result?.content;
    const fromResult = new Set<string>();
    if (typeof content === "string") {
      for (const line of content.split("\n")) {
        if (/delivered/i.test(line) && !/not delivered|undelivered/i.test(line)) {
          for (const m of line.match(UUID_RE) ?? []) {
            fromResult.add(m);
          }
        }
      }
    }
    fromResult.delete(sender.id);
    if (fromResult.size > 0) {
      return [...fromResult];
    }
    const scope = call.args.scope;
    const subs = [...this.agents.values()].filter((a) => !a.isMain && a.id !== sender.id && !a.disposed);
    if (scope === "children") {
      return subs.filter((a) => a.parentId === sender.id).map((a) => a.id);
    }
    if (scope === "siblings") {
      return subs.filter((a) => a.parentId === sender.parentId).map((a) => a.id);
    }
    return [];
  }

  private reusableCandidates(parentId: string, agentType: string | undefined, at: number, excludeId: string): string[] {
    if (!agentType) {
      return [];
    }
    const out: string[] = [];
    for (const a of this.agents.values()) {
      if (
        !a.isMain &&
        a.id !== excludeId &&
        a.parentId === parentId &&
        a.agentType === agentType &&
        a.multiTurn &&
        this.statusOf(a, at) === "idle"
      ) {
        out.push(a.id);
      }
    }
    return out;
  }

  private statusOf(a: AgentState, now: number): AgentStatus {
    if (a.failed) {
      return "failed";
    }
    const quietFor = now - a.lastActivityAt;
    const hasOpenWork = a.openTurns > 0 || a.pendingTools.size > 0;
    if (a.isMain) {
      if (this.ended) {
        return "done";
      }
      return (hasOpenWork && quietFor < BUSY_STALE_MS) || quietFor < MAIN_QUIET_MS ? "running" : "idle";
    }
    if (a.disposed) {
      return "done";
    }
    if (a.lastCompletedAt === undefined) {
      if (this.ended) {
        return "done";
      }
      if (hasOpenWork) {
        return quietFor < BUSY_STALE_MS ? "running" : "done";
      }
      return quietFor < STALE_MS ? "running" : "done";
    }
    if (hasOpenWork && a.lastActivityAt > a.lastCompletedAt && quietFor < BUSY_STALE_MS) {
      return "running";
    }
    if (
      a.pendingDeliveryAt !== undefined &&
      a.pendingDeliveryAt >= a.lastCompletedAt &&
      now - a.pendingDeliveryAt < DELIVERY_GRACE_MS
    ) {
      return "running";
    }
    if (a.lastActivityAt > a.lastCompletedAt && quietFor < SUB_QUIET_MS) {
      return "running";
    }
    if (this.ended) {
      return "done";
    }
    return a.multiTurn ? "idle" : "done";
  }

  private statusText(a: AgentState, status: AgentStatus, now: number): string {
    switch (status) {
      case "running": {
        const tool = this.currentTool(a);
        if (a.pendingDeliveryAt !== undefined && a.openTurns === 0 && !tool) {
          return "received a new task";
        }
        if (a.isMain && !tool && this.hasRunningSubagents(now)) {
          return "coordinating";
        }
        return tool ? `running · ${tool}` : "thinking";
      }
      case "idle":
        if (a.isMain) {
          return this.hasRunningSubagents(now) ? "waiting for sub-agents" : "waiting for you";
        }
        return "idle · can be reused";
      case "done":
        if (a.isMain) {
          return "session ended";
        }
        if (a.disposed || this.ended) {
          return "done · session ended";
        }
        return a.multiTurn ? "done" : "done · not reusable";
      case "failed":
        return "failed";
    }
  }

  private hasRunningSubagents(now: number): boolean {
    for (const a of this.agents.values()) {
      if (!a.isMain && this.statusOf(a, now) === "running") {
        return true;
      }
    }
    return false;
  }

  private currentTool(a: AgentState): string | undefined {
    let last: string | undefined;
    for (const name of a.pendingTools.values()) {
      last = name;
    }
    return last;
  }

  private depthOf(a: AgentState): number {
    let depth = 0;
    let cur: AgentState | undefined = a;
    const seen = new Set<string>();
    while (cur?.parentId && !seen.has(cur.id)) {
      seen.add(cur.id);
      depth++;
      cur = this.agents.get(cur.parentId);
    }
    return depth;
  }

  private agentFor(agentId: string | undefined, at: number, parentHint: string = MAIN_AGENT_ID): AgentState | undefined {
    if (!agentId) {
      return undefined;
    }
    let agent = this.agents.get(agentId);
    if (!agent) {
      // Events for an agent whose start was not observed (e.g. log rotated).
      agent = this.newAgent(agentId, this.agents.has(parentHint) ? parentHint : MAIN_AGENT_ID, `agent ${agentId.slice(0, 8)}`, at, false);
      this.agents.set(agentId, agent);
    }
    return agent;
  }

  private newAgent(id: string, parentId: string | null, name: string, at: number, isMain: boolean): AgentState {
    return {
      id,
      isMain,
      parentId,
      name,
      multiTurn: false,
      createdAt: at,
      lastActivityAt: at,
      failed: false,
      disposed: false,
      openTurns: 0,
      pendingTools: new Map(),
      toolCalls: 0,
      errors: 0,
      recentTools: [],
      reuseCount: 0,
      steerCount: 0,
      couldHaveReused: [],
    };
  }

  private disposeSubagents(): void {
    for (const a of this.agents.values()) {
      if (!a.isMain) {
        a.disposed = true;
        a.openTurns = 0;
        a.pendingTools.clear();
      }
    }
  }

  private touch(a: AgentState, at: number): void {
    a.lastActivityAt = Math.max(a.lastActivityAt, at);
  }

  private label(a: AgentState): string {
    return a.isMain ? "Main agent" : `“${a.name}”`;
  }

  private preview(text: string | undefined): string | undefined {
    return this.options.showPreviews ? truncate(text, 140) : undefined;
  }

  private toolTitle(args: Record<string, any>): string | undefined {
    if (!this.options.showPreviews) {
      return undefined;
    }
    const raw = args.description ?? args.intent ?? args.query ?? args.pattern ?? args.path ?? args.filePath;
    if (typeof raw !== "string") {
      return undefined;
    }
    const value = /[\\/]/.test(raw) && raw === (args.path ?? args.filePath) ? raw.split(/[\\/]/).pop() ?? raw : raw;
    return truncate(value, 70);
  }

  private pushTask(task: TaskView): void {
    this.tasks.push(task);
    if (this.tasks.length > MAX_TASKS) {
      // Never drop spawn edges; they define the tree.
      const idx = this.tasks.findIndex((t) => t.kind !== "spawn");
      this.tasks.splice(idx >= 0 ? idx : 0, 1);
    }
  }

  private pushFeed(kind: FeedKind, at: number, text: string, agentId?: string): void {
    this.feed.push({ id: `f${this.seq}-${this.feed.length}`, at, kind, agentId, text });
    if (this.feed.length > MAX_FEED) {
      this.feed.splice(0, this.feed.length - MAX_FEED);
    }
  }
}

function normalizeArgs(raw: unknown): Record<string, any> {
  if (raw && typeof raw === "object") {
    return raw as Record<string, any>;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      // Not JSON.
    }
  }
  return {};
}

function explicitTargets(args: Record<string, any>): string[] {
  const out: string[] = [];
  if (typeof args.agent_id === "string") {
    out.push(args.agent_id);
  }
  if (Array.isArray(args.agent_ids)) {
    for (const id of args.agent_ids) {
      if (typeof id === "string" && !out.includes(id)) {
        out.push(id);
      }
    }
  }
  return out;
}
