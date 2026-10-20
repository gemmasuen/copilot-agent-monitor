# Changelog

## 0.1.0

- Live graph of the main agent and its sub-agents (nesting, status, model, tools, tokens).
- Classifies every hand-over: new agent, reuse of an idle agent, follow-up to a running agent, sub-agent ↔ sub-agent message, result collection.
- Highlights new agents created while an idle agent of the same type could have been reused.
- Plain-language activity feed, a details panel and status bar counts.
- Sources: Copilot CLI / SDK session logs and VS Code Local-harness transcripts; follows the most recently active session.
- Streams multi-GB logs incrementally.
