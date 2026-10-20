/**
 * Dev tool: follows a live session from the terminal using the same controller as the extension.
 *   npm run watch-session -- [copilot:<session-id>]
 */
import { MonitorController } from "../src/controller";
import { defaultCopilotSessionStateDir, vscodeWorkspaceStorageDirs } from "../src/sources/discovery";

async function main() {
  const key = process.argv[2];
  const ctl = new MonitorController({
    copilotSessions: true,
    vscodeTranscripts: true,
    copilotStateDir: defaultCopilotSessionStateDir(),
    vscodeStorageDirs: vscodeWorkspaceStorageDirs(),
    showPreviews: true,
  });
  const seen = new Set<string>();
  let primed = false;
  let lastCounts = "";
  ctl.onDidChangeSnapshot((s) => {
    if (!s || s.loading) {
      return;
    }
    if (!primed) {
      s.feed.forEach((f) => seen.add(f.id));
      primed = true;
      console.log(`[watch] following ${s.title} (${s.agents.length - 1} existing sub-agents)`);
    }
    for (const f of s.feed) {
      if (!seen.has(f.id)) {
        seen.add(f.id);
        console.log(`[${new Date(f.at).toISOString().slice(11, 19)}] ${f.kind.toUpperCase()}: ${f.text}`);
      }
    }
    const counts = JSON.stringify(s.counts);
    if (counts !== lastCounts) {
      lastCounts = counts;
      console.log(`[counts] ${counts}`);
    }
  });
  await ctl.start();
  if (key) {
    await ctl.selectSession(key);
  }
}

void main();
