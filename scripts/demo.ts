import { EventBuilder } from "../test/builders";

const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

/** A synthetic session that exercises every visual: spawn, reuse, steer, peer, nesting, failure and "new instead of reuse". */
export function buildDemo(start: number): EventBuilder {
  const A = id(1);
  const B = id(2);
  const C = id(3);
  const D = id(4);
  const E = id(5);
  const b = new EventBuilder(start).sessionStart("claude-opus-5.5");
  b.push("user.message", { content: "Refactor the auth module, add tests and update the docs" });
  b.push("assistant.turn_start", {});
  b.advance(2000).spawn({ callId: "c-a", agentId: A, name: "map-auth-code", type: "explore", description: "Map the auth module and its callers" });
  b.advance(800).spawn({ callId: "c-b", agentId: B, name: "oauth-practices", type: "research", description: "Research current OAuth token refresh guidance" });
  b.push("assistant.turn_end", {});
  b.advance(1500).agentWork(A, "a1", "grep");
  b.advance(1500).agentWork(B, "b1", "web_search");
  b.advance(1500).agentWork(A, "a2", "view");
  b.advance(4000).complete(B, "c-b", { totalTokens: 182_000, durationMs: 9_000, totalToolCalls: 7 });
  b.advance(3000).complete(A, "c-a", { totalTokens: 96_000, durationMs: 14_000, totalToolCalls: 11 });
  b.advance(2000).toolStart("r-a", "read_agent", { agent_id: A }).toolComplete("r-a");
  b.advance(10_000).push("assistant.turn_start", {});
  b.toolStart("w-a", "write_agent", { agent_id: A, message: "Now find every caller of validateToken()" }).toolComplete("w-a");
  b.advance(1000).agentWork(A, "a3", "grep");
  b.advance(1500).spawn({ callId: "c-c", agentId: C, name: "implement-refactor", type: "general-purpose", description: "Refactor token validation into AuthService" });
  b.advance(1500).push("assistant.turn_start", {}, C);
  b.toolStart("c1", "edit", { path: "src/auth/service.ts" }, C);
  b.advance(2000).toolComplete("c1", true, undefined, C);
  b.advance(500).spawn({ callId: "c-d", agentId: D, name: "test-writer", type: "task", by: C, multiTurn: false, mode: "sync", description: "Write unit tests for AuthService" });
  b.advance(1500).agentWork(D, "d1", "powershell");
  b.advance(3000).complete(D, "c-d", { totalTokens: 41_000, durationMs: 4_500, totalToolCalls: 4 });
  b.toolComplete("c-d", true, undefined, C);
  b.advance(10_000).spawn({ callId: "c-e", agentId: E, name: "find-config", type: "explore", description: "Find where auth settings are configured" });
  b.advance(1000).toolStart("w-c", "write_agent", { scope: "siblings", message: "AuthService API is ready: validate(token)" }, C);
  b.toolComplete("w-c", true, { content: `Message delivered to 2 agents.\n- ${E}, delivered\n- ${A}, delivered` }, C);
  b.advance(1500).toolStart("w-c2", "write_agent", { agent_id: C, message: "Also update docs/auth.md" }).toolComplete("w-c2");
  b.advance(1000).toolStart("c-f", "task", { name: "perf-audit", agent_type: "general-purpose", description: "Audit auth performance" });
  b.push("tool.execution_complete", { toolCallId: "c-f", success: false, error: { message: "requested model exceeds the session tier" } });
  b.advance(1500).agentWork(E, "e1", "glob");
  b.advance(2500).push("assistant.turn_start", {}, C).toolStart("c2", "powershell", { description: "Run the test suite" }, C);
  return b;
}
