# Changelog

All notable changes to `pi-sentry-monitor` are documented here.

## [0.1.11] - 2026-03-19

### Fixed
- **Model "unknown" on invoke_agent spans** — the root `gen_ai.invoke_agent`
  span now gets stamped with the final known model (`gen_ai.request.model` and
  `gen_ai.response.model`) before ending, fixing the "unknown" label in Sentry
  regardless of `model_select` event timing.
- **Missing response on invoke_agent spans** — the agent span now carries
  `gen_ai.response.text` with the last assistant response, so Sentry's AI
  Spans view shows both Input and Output on the root span.
- **`gen_ai.response.model` missing on request spans** — all `gen_ai.request`
  child spans now set `gen_ai.response.model` alongside `gen_ai.request.model`,
  aligning with the Sentry AI Agent Monitoring conventions.

## [0.1.5] - 2026-03-13

### Changed
- **Dynamic agent name detection** — rewrote subagent name detection to work
  entirely within this package, with no changes required to `pi-subagents`.
  When spawned by `pi-subagents`, the agent's system prompt is written to a
  temp file named `{agent}.md` inside a `pi-subagent-XXXX/` directory and
  passed via `--append-system-prompt`. The extension now reads `process.argv`
  to extract the agent name from that path, building `{project}/{agent}` span
  names (e.g. `my-project/worker`) automatically.

## [0.1.4] - 2026-03-13

### Added
- **Dynamic agent name** — when pi-subagents spawns a named agent (worker,
  scout, reviewer, etc.), the `gen_ai.invoke_agent` span name now includes
  both the project directory and the agent name: `my-project/worker`.
  Falls back to `basename(cwd)` for the main session.

## [0.1.3] - 2026-03-13

### Fixed
- **Sentry AI Spans inputs/outputs not showing** — the extension was setting
  `gen_ai.content.prompt` and `gen_ai.content.completion` on request spans,
  but Sentry's AI Spans view (and the "Open in AI View" button) requires
  `gen_ai.input.messages` (JSON-encoded `[{role, content}]` array) and
  `gen_ai.response.text`. Updated both attribute names and the input format
  to match Sentry's OpenTelemetry GenAI conventions.

## [0.1.2] - 2026-03-13

### Fixed
- Corrected broken links in README for pi and opencode-sentry-monitor.

## [0.1.1] - 2026-03-13

### Added
- **Interactive setup skill** — `pi-sentry-monitor` skill now walks through
  configuration interactively, collecting DSN, scope, agent/project name,
  developer tag, environment, and sample rate.
- **Auto-detection** — skill auto-detects project name from `basename(cwd)`
  and developer identity from `git config user.name` / GitHub CLI.

## [0.1.0] - 2026-03-13

### Added
- Initial release.
- `gen_ai.invoke_agent` root span covering the full pi session.
- `gen_ai.request` child spans per LLM call with token usage, model name,
  input messages, and completion text.
- `gen_ai.execute_tool` spans for every tool call with inputs and outputs.
- Token usage metrics (`gen_ai.usage.*`) on every request span.
- Configurable via `sentry-monitor.json` / `pi-sentry-monitor.json` in
  `.pi/` (project) or `~/.pi/agent/` (global), with env var overrides.
- `recordInputs` / `recordOutputs` flags to control PII capture.
- Optional Sentry metrics (`enableMetrics`) for token usage distributions.
