import { describe, expect, it } from "vitest";
import { MAIN_AGENT_ID, OrchestrationModel } from "../src/model/orchestration";
import { EventBuilder } from "./builders";

function run(b: EventBuilder, opts = { showPreviews: true }, source: "copilot" | "vscode" = "copilot") {
  const m = new OrchestrationModel("s1", source, "Test", opts);
  for (const e of b.events) {
    m.apply(e);
  }
  return m;
}

const agent = (snap: ReturnType<OrchestrationModel["snapshot"]>, id: string) => {
  const a = snap.agents.find((x) => x.id === id);
  if (!a) {
    throw new Error(`agent ${id} missing`);
  }
  return a;
};

describe("OrchestrationModel", () => {
  it("creates a running sub-agent that becomes idle (reusable) after completion", () => {
    const b = new EventBuilder().sessionStart();
    b.push("user.message", { content: "Please research auth" });
    b.push("assistant.turn_start", { turnId: "0" });
    b.spawn({ callId: "c1", agentId: "A", name: "auth-research", description: "Research auth flow" });
    b.agentWork("A", "t1");

    let snap = run(b).snapshot(b.now);
    expect(agent(snap, "A").status).toBe("running");
    expect(agent(snap, "A").parentId).toBe(MAIN_AGENT_ID);
    expect(snap.tasks.map((t) => t.kind)).toEqual(["spawn"]);
    expect(snap.feed.some((f) => f.kind === "spawn" && f.text.includes("“auth-research”"))).toBe(true);

    b.advance(1000).complete("A", "c1");
    snap = run(b).snapshot(b.now + 10_000);
    const a = agent(snap, "A");
    expect(a.status).toBe("idle");
    expect(a.statusText).toContain("reused");
    expect(a.tokens).toBe(12345);
    expect(snap.counts).toEqual({ running: 0, idle: 1, done: 0, failed: 0 });
    expect(snap.feed.at(-1)?.text).toContain("can be reused");
  });

  it("classifies write_agent to an idle agent as reuse and to a running agent as steer", () => {
    const b = new EventBuilder().sessionStart();
    b.spawn({ callId: "c1", agentId: "A", name: "worker" });
    b.agentWork("A", "t1");
    b.toolStart("w1", "write_agent", { agent_id: "A", message: "also check logout" });
    b.toolComplete("w1");
    b.advance(1000).complete("A", "c1");
    b.advance(20_000);
    b.toolStart("w2", "write_agent", { agent_id: "A", message: "now fix the bug" });
    b.toolComplete("w2");

    const m = run(b);
    let snap = m.snapshot(b.now + 100);
    expect(snap.tasks.map((t) => t.kind)).toEqual(["spawn", "steer", "reuse"]);
    const a = agent(snap, "A");
    expect(a.reuseCount).toBe(1);
    expect(a.steerCount).toBe(1);
    expect(a.status).toBe("running");
    expect(a.statusText).toBe("received a new task");
    expect(snap.feed.some((f) => f.kind === "reuse" && f.text.includes("reused idle agent “worker”"))).toBe(true);

    // The reused agent works and goes quiet without a second subagent.completed.
    b.advance(1000).agentWork("A", "t2");
    for (const e of b.events.slice(-4)) {
      m.apply(e);
    }
    expect(agent(m.snapshot(b.now + 1000), "A").status).toBe("running");
    expect(agent(m.snapshot(b.now + 30_000), "A").status).toBe("idle");
  });

  it("flags a new agent created while an idle agent of the same type could have been reused", () => {
    const b = new EventBuilder().sessionStart();
    b.spawn({ callId: "c1", agentId: "A", name: "first", type: "explore" });
    b.complete("A", "c1");
    b.advance(30_000);
    b.spawn({ callId: "c2", agentId: "B", name: "second", type: "explore" });
    b.spawn({ callId: "c3", agentId: "C", name: "other-type", type: "task" });

    const snap = run(b).snapshot(b.now);
    expect(agent(snap, "B").couldHaveReused).toEqual(["A"]);
    expect(agent(snap, "C").couldHaveReused).toEqual([]);
    expect(snap.feed.find((f) => f.agentId === "B")?.text).toContain("instead of reusing idle “first”");
  });

  it("does not flag replacement when the earlier agent was single-turn", () => {
    const b = new EventBuilder().sessionStart();
    b.spawn({ callId: "c1", agentId: "A", name: "first", multiTurn: false, mode: "sync" });
    b.complete("A", "c1");
    b.toolComplete("c1");
    b.advance(30_000);
    b.spawn({ callId: "c2", agentId: "B", name: "second" });
    const snap = run(b).snapshot(b.now);
    expect(agent(snap, "A").status).toBe("done");
    expect(agent(snap, "A").statusText).toBe("done · not reusable");
    expect(agent(snap, "B").couldHaveReused).toEqual([]);
  });

  it("attributes nested spawns and inner tool calls to the right agent", () => {
    const b = new EventBuilder().sessionStart();
    b.spawn({ callId: "c1", agentId: "A", name: "lead" });
    b.push("assistant.turn_start", {}, "A");
    b.toolStart("x1", "powershell", { description: "Run tests", command: "npm test" }, "A");
    b.spawn({ callId: "c2", agentId: "B", name: "helper", by: "A" });

    const snap = run(b).snapshot(b.now);
    const a = agent(snap, "A");
    const child = agent(snap, "B");
    expect(child.parentId).toBe("A");
    expect(child.depth).toBe(2);
    expect(a.currentTool).toBe("powershell");
    expect(a.recentTools.find((t) => t.name === "powershell")?.title).toBe("Run tests");
    expect(snap.tasks.find((t) => t.toAgentId === "B")?.fromAgentId).toBe("A");
  });

  it("resolves sibling broadcasts from the delivery result as peer messages", () => {
    const A = "11111111-1111-4111-8111-111111111111";
    const B = "22222222-2222-4222-8222-222222222222";
    const b = new EventBuilder().sessionStart();
    b.spawn({ callId: "c1", agentId: A, name: "frontend" });
    b.spawn({ callId: "c2", agentId: B, name: "backend" });
    b.toolStart("w1", "write_agent", { scope: "siblings", message: "API contract is ready" }, A);
    b.toolComplete("w1", true, { content: `Message delivered to 1 agent.\n- ${B}, delivered, relation=sibling` }, A);

    const snap = run(b).snapshot(b.now);
    const peer = snap.tasks.find((t) => t.kind === "peer");
    expect(peer).toMatchObject({ fromAgentId: A, toAgentId: B, summary: "API contract is ready" });
    expect(snap.feed.at(-1)?.text).toBe("“frontend” → “backend”: API contract is ready");
  });

  it("records a failed spawn when the task tool fails before an agent starts", () => {
    const b = new EventBuilder().sessionStart();
    b.toolStart("c1", "task", { name: "too-big", agent_type: "general-purpose", description: "x" });
    b.push("tool.execution_complete", { toolCallId: "c1", success: false, error: { message: "model not allowed" } });
    const snap = run(b).snapshot(b.now);
    const a = agent(snap, "c1");
    expect(a.status).toBe("failed");
    expect(snap.counts.failed).toBe(1);
    expect(snap.feed.at(-1)?.text).toContain("model not allowed");
  });

  it("models VS Code Local-harness sub-agents as stateless", () => {
    const b = new EventBuilder();
    b.push("session.start", { sessionId: "v1" });
    b.push("user.message", { content: "find the prompt guide" });
    b.toolStart("v1", "runSubagent", { agentName: "Researcher Subagent", description: "Find prompt guide", prompt: "…" });
    let snap = run(b, undefined, "vscode").snapshot(b.now);
    expect(agent(snap, "v1")).toMatchObject({ name: "Researcher Subagent", status: "running", multiTurn: false });
    expect(snap.supportsReuse).toBe(false);

    b.advance(5000).toolComplete("v1");
    b.toolStart("v2", "execution_subagent", { description: "Create PDF", query: "…" });
    snap = run(b, undefined, "vscode").snapshot(b.now);
    expect(agent(snap, "v1")).toMatchObject({ status: "done", durationMs: 5000 });
    expect(agent(snap, "v2")).toMatchObject({ name: "Create PDF", agentType: "execution", status: "running" });
  });

  it("marks everything done when the session shuts down", () => {
    const b = new EventBuilder().sessionStart();
    b.spawn({ callId: "c1", agentId: "A", name: "worker" });
    b.complete("A", "c1");
    b.push("session.shutdown", {});
    const m = run(b);
    const snap = m.snapshot(b.now);
    expect(snap.ended).toBe(true);
    expect(agent(snap, "A").statusText).toBe("done · session ended");
    expect(agent(snap, MAIN_AGENT_ID).status).toBe("done");
    expect(m.isLive(b.now)).toBe(false);
  });

  it("omits message and description previews when previews are disabled", () => {
    const b = new EventBuilder().sessionStart();
    b.push("user.message", { content: "private request" });
    b.spawn({ callId: "c1", agentId: "A", name: "worker", description: "private description" });
    b.toolStart("w1", "write_agent", { agent_id: "A", message: "private message" });
    const snap = run(b, { showPreviews: false }).snapshot(b.now);
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("secret prompt");
  });

  it("never exposes raw prompts even with previews enabled", () => {
    const b = new EventBuilder().sessionStart();
    b.spawn({ callId: "c1", agentId: "A", name: "worker" });
    expect(JSON.stringify(run(b).snapshot(b.now))).not.toContain("secret prompt");
  });

  it("treats a never-completed agent with no activity for a long time as stopped", () => {
    const b = new EventBuilder().sessionStart();
    b.spawn({ callId: "c1", agentId: "A", name: "worker" });
    const m = run(b);
    expect(agent(m.snapshot(b.now + 60_000), "A").status).toBe("running");
    expect(agent(m.snapshot(b.now + 16 * 60_000), "A").status).toBe("done");
  });
});
