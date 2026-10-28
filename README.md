---
title: Copilot Agent Monitor
description: A live visual map of Copilot agents, sub-agent reuse, and orchestration feedback.
---

## Copilot Agent Monitor

A live, visual map of what your Copilot agent is doing with its **sub-agents**: when it creates them, what each one is working on, and, when the next task comes along, whether it **reuses** an existing agent or **creates a new one**.

Inspired by the Agent Manager in Google Antigravity.

![Agent Monitor showing a main agent, reused and new sub-agents, a nested fan-out wrapping four cards per row, peer messages and the activity feed](media/screenshot.png)

## What you see

| Visual | Meaning |
| --- | --- |
| Blue pulsing card, animated dashed edge | Agent is working |
| Green dashed card, “idle · can be reused” | Finished but kept alive; it can take another task |
| Grey card, “single-use” | Finished and discarded (sync or VS Code Local sub-agents) |
| Red card | Failed to start or failed while running |
| Thick purple edge, **↻ n** chip, “reused ×n” badge | The agent got *n* new tasks **after** it had finished (reuse) |
| **✉ n** chip | Follow-ups sent while the agent was still running |
| Dashed cyan arc, **⇄ n** | Messages between sub-agents |
| Dashed orange edge, “new, not reused” badge | A **new** agent was created while an idle agent of the same type could have been reused |
| Moving dot along an edge | A task or message is being handed over right now |

The side panel shows the selected agent's details (type, model, reusable or not, tokens, tasks received, recent tools). Below it is an **activity feed** that narrates the orchestration in plain language, for example *“Main agent reused idle agent “map-auth-code” for a new task: …”*.

The status bar shows how many sub-agents are running or idle. Click it to open the monitor.

## Feedback-loop example

An agent orchestration can repeat a review-and-fix cycle rather than delegate each task once.
This synthetic, gauntlet-style example keeps one implementer and three reviewers alive across
three rounds. Correctness review, regression tests, and a design challenger report blockers;
the coordinator sends the implementer back for two fix cycles. The loop exits only when all
three reviewers approve the same revision.

![Synthetic gauntlet showing three reviewers, two fix cycles, reused agents, and approval feedback](media/gauntlet-screenshot.png)

Purple **reused ×2** badges show repeat assignments. Cyan message arcs show reviewers sending
feedback to the implementer and the implementer announcing revisions for another review.
Select an agent to inspect the round-by-round messages. These are existing orchestration
visuals, not a separate loop detector or an implementation of a specific Gauntlet framework.

## Usage

- **Copilot Agent Monitor: Open Agent Monitor** opens the graph beside your editor.
- **Follow latest** (on by default) switches to the most recently active session once the current one has been quiet for 20 seconds.
- **Copilot Agent Monitor: Select Session…** pins a specific session (this turns Follow off).
- **Reload** re-reads the session from disk.
- Graph controls: scroll to zoom, drag to pan, **Fit** to reset the view, and click a card or a feed entry to inspect it.

Groups of sibling agents without children wrap at four cards per row, so larger sessions grow downward.
Nested delegations keep their tree layout.

## Data sources

The extension only **reads** local log files. Nothing is sent anywhere.

| Source | Location | Reuse possible? |
| --- | --- | --- |
| Copilot CLI / Copilot SDK harness | `~/.copilot/session-state/<id>/events.jsonl` | **Yes**: background sub-agents stay alive and can receive follow-ups (`write_agent`). |
| VS Code Local harness | `<VS Code user dir>/workspaceStorage/*/GitHub.copilot-chat/transcripts/*.jsonl` | **No**: every `runSubagent` call is a new, single-use agent. Their inner tool calls are not recorded. |

How agents are recognised (Copilot harness):

- `subagent.started` / `subagent.configured` / `subagent.completed` give the agent's identity, model, `multiTurn` flag and totals.
- Tool events carry the `agentId` of the agent that ran them, so nesting and per-agent activity are exact.
- `write_agent` / `read_agent` with an `agent_id` mark reuse, follow-ups and result collection. Sibling broadcasts are resolved from the delivery result.

Both formats are internal and undocumented, so the parser is deliberately tolerant. Logs of several GB are streamed, and irrelevant lines are skipped without being parsed (a 2.1 GB session loads in about 1.5 s).

## Settings

| Setting | Default | |
| --- | --- | --- |
| `copilotAgentMonitor.sources.copilotSessions` | `true` | Monitor Copilot CLI / SDK sessions |
| `copilotAgentMonitor.sources.vscodeTranscripts` | `true` | Monitor VS Code Local-harness transcripts |
| `copilotAgentMonitor.copilotSessionStateDir` | `""` | Override `~/.copilot/session-state` |
| `copilotAgentMonitor.showPreviews` | `true` | Show truncated task descriptions and messages. Full prompts and file contents are never shown. |
| `copilotAgentMonitor.statusBar` | `true` | Show sub-agent counts in the status bar |

## Development

```powershell
npm install
npm run build        # bundle extension + webview into dist/
npm test             # vitest unit tests
npm run typecheck
npm run preview      # dist/preview.html: the real webview replaying a synthetic demo in a browser
npm run preview -- --gauntlet  # replay the synthetic, repeated review/fix loop instead
npm run inspect -- <path\to\events.jsonl> --feed   # text summary of a session's orchestration
npm run package      # typecheck + test + production build + VSIX
```

Press <kbd>F5</kbd> to launch an Extension Development Host.

Open the generated `dist/preview.html` in a browser to watch either demo. For a still image,
append `?frame=999&play=0` to show the final frame without replaying the animation.

Install the packaged VSIX with `code --install-extension copilot-agent-monitor-<version>.vsix`.

## Credits

Discovery of VS Code transcript folders and the webview panel lifecycle are adapted from [copilot-agent-viz](https://github.com/ilyas-it83/copilot-agent-viz) by Ilyas F (MIT). See [NOTICE](NOTICE).

## License

[MIT](LICENSE)
