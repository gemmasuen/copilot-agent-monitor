import { describe, expect, it } from "vitest";
import { buildDemo, buildGauntletDemo } from "../scripts/demo";
import { OrchestrationModel } from "../src/model/orchestration";

describe("synthetic demos", () => {
  it("keeps the original demo's failure, nesting and reuse examples", () => {
    const b = buildDemo(Date.parse("2026-10-20T09:00:00Z"));
    const model = new OrchestrationModel("demo", "copilot", "Demo");
    for (const event of b.events) model.apply(event);
    const snap = model.snapshot(b.now + 1500);
    expect(snap.counts).toEqual({ running: 2, idle: 2, done: 1, failed: 1 });
    expect(snap.agents.some((a) => a.depth === 2)).toBe(true);
    expect(snap.tasks.some((t) => t.kind === "reuse")).toBe(true);
  });

  it("reuses the same agents for three review rounds and two fix cycles before approval", () => {
    const b = buildGauntletDemo(Date.parse("2026-10-20T09:00:00Z"));
    const model = new OrchestrationModel("gauntlet", "copilot", "Gauntlet");
    for (const event of b.events) model.apply(event);
    const snap = model.snapshot(b.now + 1500);
    const implementer = snap.agents.find((a) => a.name === "retry-implementer")!;
    const reviewers = snap.agents.filter((a) => !a.isMain && a.id !== implementer.id);

    expect(snap.agents).toHaveLength(5);
    expect(snap.tasks.filter((t) => t.kind === "spawn")).toHaveLength(4);
    expect(implementer.reuseCount).toBe(2);
    expect(reviewers).toHaveLength(3);
    expect(reviewers.every((a) => a.reuseCount === 2 && a.steerCount === 0)).toBe(true);
    expect(snap.agents.every((a) => a.couldHaveReused.length === 0)).toBe(true);
    expect(snap.counts).toEqual({ running: 0, idle: 4, done: 0, failed: 0 });

    const feedback = snap.tasks.filter((t) => t.kind === "peer" && t.toAgentId === implementer.id);
    expect(feedback).toHaveLength(9);
    expect(feedback.filter((t) => t.summary?.includes("BLOCK"))).toHaveLength(5);
    expect(feedback.slice(-3).every((t) => t.summary?.includes("Round 3 APPROVED"))).toBe(true);
    expect(new Set(feedback.slice(-3).map((t) => t.fromAgentId)).size).toBe(3);
    expect(snap.tasks.filter((t) => t.kind === "peer" && t.fromAgentId === implementer.id)).toHaveLength(6);
    expect(snap.tasks.filter((t) => t.kind === "reuse" && t.toAgentId === implementer.id)
      .every((fix) => feedback.some((t) => t.at < fix.at && t.summary?.includes("BLOCK")))).toBe(true);
    expect(snap.feed.some((f) => f.text.includes("All three reviewers pass; exit loop."))).toBe(true);
  });
});
