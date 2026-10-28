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

/** A synthetic three-round review gauntlet with two fix cycles and a unanimous approval gate. */
export function buildGauntletDemo(start: number): EventBuilder {
  const implementer = id(1);
  const reviewers = [
    { agentId: id(2), name: "correctness-review", type: "code-review", tool: "view" },
    { agentId: id(3), name: "regression-tests", type: "task", tool: "powershell" },
    { agentId: id(4), name: "design-challenger", type: "rubber-duck", tool: "view" },
  ];
  const rounds = [
    {
      revision: "Round 1: implement retry handling",
      feedback: [
        "Round 1 BLOCK: retry counter resets after reconnect. Preserve the attempt budget.",
        "Round 1 BLOCK: timeout regression fails. Add a bounded-retry test.",
        "Round 1 BLOCK: cancellation has no owner. Define who stops pending retries.",
      ],
      fix: "Round 1 rejected. Fix retry budget, timeout coverage and cancellation ownership.",
    },
    {
      revision: "Round 2: retry budget and cancellation fixed",
      feedback: [
        "Round 2 PASS: retry budget is bounded. Keep that invariant in the next revision.",
        "Round 2 BLOCK: cancellation during backoff still fails. Add a race regression.",
        "Round 2 BLOCK: backoff timer survives cancellation. Clear it before handoff.",
      ],
      fix: "Round 2 rejected. Clear the backoff timer on cancel and cover the race.",
    },
    {
      revision: "Round 3: cancellation race fixed",
      feedback: [
        "Round 3 APPROVED: retry budget and cancellation invariants hold.",
        "Round 3 APPROVED: all regression tests pass, including the cancellation race.",
        "Round 3 APPROVED: timer cleanup is explicit. All three reviewers pass; exit loop.",
      ],
    },
  ];
  const b = new EventBuilder(start).sessionStart("claude-opus-5.5");
  b.push("user.message", { content: "Synthetic gauntlet: build retry handling; repeat review and fixes until all three reviewers approve." });
  b.push("assistant.turn_start", {});
  b.advance(2000).spawn({
    callId: "g-implement", agentId: implementer, name: "retry-implementer", type: "general-purpose",
    description: "Implement retry handling; address every blocking review before the next gauntlet round",
  });
  b.agentWork(implementer, "g-implementation", "edit");
  b.complete(implementer, "g-implement");

  for (const [round, spec] of rounds.entries()) {
    b.advance(8000);
    for (const [i, reviewer] of reviewers.entries()) {
      const callId = `g-review-${round}-${i}`;
      const request = `${spec.revision}. Challenge the revision; report PASS or BLOCK with a concrete reason.`;
      if (round === 0) {
        b.spawn({ callId, ...reviewer, description: request });
      } else {
        b.toolStart(callId, "write_agent", { agent_id: reviewer.agentId, message: request }).toolComplete(callId);
      }
    }
    for (const [i, reviewer] of reviewers.entries()) {
      b.advance(1500).agentWork(reviewer.agentId, `g-check-${round}-${i}`, reviewer.tool);
      const feedbackId = `g-feedback-${round}-${i}`;
      b.toolStart(feedbackId, "write_agent", {
        agent_id: implementer, message: spec.feedback[i],
      }, reviewer.agentId).toolComplete(feedbackId, true, undefined, reviewer.agentId);
      if (round === 0) {
        b.complete(reviewer.agentId, `g-review-${round}-${i}`);
      }
    }
    if (spec.fix) {
      const fixId = `g-fix-${round}`;
      b.advance(1000).toolStart(fixId, "write_agent", { agent_id: implementer, message: spec.fix }).toolComplete(fixId);
      b.advance(1500).agentWork(implementer, `g-edit-${round}`, "edit");
      const readyId = `g-ready-${round}`;
      b.toolStart(readyId, "write_agent", {
        scope: "siblings", message: `Revision ${round + 2} ready. Re-run the gauntlet against every previous blocker.`,
      }, implementer).toolComplete(readyId, true, {
        content: `Message delivered to 3 agents.\n${reviewers.map((r) => `- ${r.agentId}, delivered`).join("\n")}`,
      }, implementer);
    }
  }
  b.advance(8000);
  for (const [i, reviewer] of reviewers.entries()) {
    b.toolStart(`g-results-${i}`, "read_agent", { agent_id: reviewer.agentId }).toolComplete(`g-results-${i}`);
  }
  b.push("assistant.turn_end", {});
  return b;
}
