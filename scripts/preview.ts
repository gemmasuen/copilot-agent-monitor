/**
 * Dev tool: renders the real webview bundle in a normal browser with a mocked VS Code API.
 *   npm run preview            -> dist/preview.html replaying a synthetic demo session
 *   npm run preview -- --gauntlet -> replays a synthetic review/fix feedback loop
 *   npm run preview -- <file>  -> replays a real events.jsonl / transcript (stays local in dist/)
 */
import * as fs from "fs";
import * as path from "path";
import { RawEvent } from "../src/model/events";
import { OrchestrationModel } from "../src/model/orchestration";
import { SessionSnapshot } from "../src/model/snapshot";
import { JsonlTailer } from "../src/sources/jsonlTail";
import { buildDemo, buildGauntletDemo } from "./demo";

const KEY_EVENTS = new Set(["subagent.started", "subagent.completed", "tool.execution_start", "tool.execution_complete"]);
const MAX_FRAMES = 80;

async function loadEvents(file?: string): Promise<{ events: RawEvent[]; source: "copilot" | "vscode"; title: string }> {
  if (file === "--gauntlet") {
    return {
      events: buildGauntletDemo(Date.parse("2026-10-20T09:00:00Z")).events,
      source: "copilot",
      title: "Synthetic gauntlet: 3 reviewers, 3 rounds, 2 fix cycles",
    };
  }
  if (!file) {
    return { events: buildDemo(Date.parse("2026-10-20T09:00:00Z")).events, source: "copilot", title: "Demo: refactor the auth module" };
  }
  const { events } = await new JsonlTailer(file).readNew();
  return { events, source: /transcripts/i.test(file) ? "vscode" : "copilot", title: path.basename(path.dirname(file)) };
}

async function main() {
  const file = process.argv[2];
  const { events, source, title } = await loadEvents(file);
  const model = new OrchestrationModel("preview", source, title);
  const frames: SessionSnapshot[] = [];
  let lastTask = 0;
  for (const e of events) {
    model.apply(e);
    const snap = model.snapshot(Date.parse(e.timestamp ?? "") + 400 || Date.now());
    if (KEY_EVENTS.has(e.type) && snap.tasks.length + snap.feed.length !== lastTask) {
      lastTask = snap.tasks.length + snap.feed.length;
      frames.push(snap);
    }
  }
  const last = events.at(-1);
  frames.push(model.snapshot((Date.parse(last?.timestamp ?? "") || Date.now()) + 1500));
  const picked = frames.length > MAX_FRAMES ? frames.filter((_, i) => i % Math.ceil(frames.length / MAX_FRAMES) === 0 || i === frames.length - 1) : frames;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Agent Monitor preview</title>
<link rel="stylesheet" href="../media/webview.css" />
<style>
  :root {
    --vscode-font-family: "Segoe UI", system-ui, sans-serif;
    --vscode-editor-font-family: Consolas, monospace;
    --vscode-font-size: 13px;
    --vscode-foreground: #cccccc;
    --vscode-descriptionForeground: #9d9d9d;
    --vscode-editor-background: #1f1f1f;
    --vscode-editorWidget-background: #252526;
    --vscode-panel-border: #3c3c3c;
    --vscode-focusBorder: #0078d4;
    --vscode-textLink-foreground: #4daafc;
    --vscode-dropdown-background: #313131;
    --vscode-dropdown-foreground: #cccccc;
    --vscode-button-secondaryBackground: #313131;
    --vscode-button-secondaryForeground: #cccccc;
  }
</style>
</head>
<body>
${extractBody()}
<script>
  const frames = ${JSON.stringify(picked)};
  const params = new URLSearchParams(location.search);
  const stepMs = Number(params.get("step") || 1400);
  const startAt = params.has("frame") ? Number(params.get("frame")) : 0;
  let frameTime = frames[0].generatedAt, postedAt = performance.now();
  const realNow = Date.now.bind(Date);
  Date.now = () => frameTime + (performance.now() - postedAt);
  const post = (msg) => window.postMessage(msg, "*");
  function show(i) {
    const f = frames[i];
    frameTime = f.generatedAt; postedAt = performance.now();
    document.title = "Agent Monitor preview " + (i + 1) + "/" + frames.length;
    post({ type: "snapshot", snapshot: f });
  }
  window.acquireVsCodeApi = () => ({
    postMessage(m) {
      console.log("webview ->", JSON.stringify(m));
      if (m.type === "openConversation") {
        console.log("preview: VS Code would open this session's conversation in chat");
        return;
      }
      if (m.type !== "ready") return;
      post({ type: "sessions", sessions: [{ key: "copilot:preview", title: frames[0].title, source: frames[0].source, mtimeMs: realNow() }], currentKey: "copilot:preview", follow: true });
      post({ type: "conversation", key: "copilot:preview", available: true });
      let i = Math.min(startAt, frames.length - 1);
      show(i);
      if (params.get("play") !== "0") {
        const timer = setInterval(() => { if (i >= frames.length - 1) { clearInterval(timer); return; } show(++i); }, stepMs);
      }
    },
    getState() { return undefined; },
    setState() {},
  });
</script>
<script src="webview.js"></script>
</body>
</html>`;
  const out = path.join(__dirname, "preview.html");
  fs.writeFileSync(out, html);
  console.log(`${picked.length} frames -> ${out}`);
}

/** Reuse the exact markup the extension serves, minus CSP/script tags. */
function extractBody(): string {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "webview", "panel.ts"), "utf8");
  const m = /<body>([\s\S]*?)<script nonce/.exec(src);
  if (!m) {
    throw new Error("Could not find body markup in panel.ts");
  }
  return m[1];
}

void main();
