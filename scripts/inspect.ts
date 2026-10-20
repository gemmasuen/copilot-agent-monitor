/**
 * Dev tool: prints the orchestration summary of a session log.
 *   npm run inspect -- <path-to-events.jsonl> [--feed]
 */
import { OrchestrationModel } from "../src/model/orchestration";
import { JsonlTailer } from "../src/sources/jsonlTail";

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: inspect <events.jsonl> [--feed]");
    process.exit(1);
  }
  const source = /transcripts/i.test(file) ? "vscode" : "copilot";
  const model = new OrchestrationModel("inspect", source, file);
  const started = Date.now();
  const tail = new JsonlTailer(file);
  const result = await tail.readNew((events) => events.forEach((e) => model.apply(e)));
  const elapsed = Date.now() - started;
  const snap = model.snapshot();
  const kinds: Record<string, number> = {};
  for (const t of snap.tasks) {
    kinds[t.kind] = (kinds[t.kind] ?? 0) + 1;
  }
  console.log(`${(result.bytesRead / 1e6).toFixed(1)} MB, ${model.eventCount} relevant events in ${elapsed} ms`);
  console.log("tasks:", kinds, "counts:", snap.counts, "ended:", snap.ended);
  for (const a of snap.agents) {
    const indent = "  ".repeat(a.depth);
    const flags = [
      a.reuseCount ? `reused×${a.reuseCount}` : "",
      a.steerCount ? `steered×${a.steerCount}` : "",
      a.couldHaveReused.length ? `could-have-reused:${a.couldHaveReused.length}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    console.log(`${indent}- ${a.name} [${a.agentType ?? "main"}] ${a.status} (${a.statusText}) tools=${a.toolCalls} mode=${a.executionMode ?? "-"} multiTurn=${a.multiTurn} parent=${a.parentId?.slice(0, 8) ?? "-"} ${flags}`);
  }
  if (process.argv.includes("--feed")) {
    for (const f of snap.feed.slice(-40)) {
      console.log(`  ${new Date(f.at).toISOString().slice(11, 19)} [${f.kind}] ${f.text}`);
    }
  }
}

void main();
