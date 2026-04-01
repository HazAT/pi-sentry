# Sentry Extension for pi

Full [Sentry](https://sentry.io) observability for [pi](https://github.com/badlogic/pi-mono) coding agent sessions — distributed tracing, error capture, and a built-in Sentry CLI tool.

## What It Does

**Monitoring** — Every agent session becomes a Sentry trace. Tool calls, LLM requests, token usage, and errors are captured as spans with full [AI Agent Monitoring](https://docs.sentry.io/product/ai-monitoring/) attributes.

**Sentry CLI tool** — Agents can query Sentry directly: list issues, view traces, inspect spans, read logs, get AI-powered explanations — all without leaving the conversation.

### Trace Structure

```
gen_ai.invoke_agent (per user interaction)
├── gen_ai.execute_tool (per tool call — bash, read, edit, etc.)
└── gen_ai.request (per LLM request — model, tokens, latency)
```

Each user message starts a new trace. Tool inputs/outputs and LLM responses are captured as span attributes.

## Install

**Global** (all projects):
```bash
pi install npm:pi-sentry
```

**Project-local** (shared with teammates):
```bash
pi install npm:pi-sentry -l
```

Run `/reload` in pi to activate without restarting.

## Configure Monitoring

Create `.pi/sentry.json` (or `.jsonc`):

```json
{
  "dsn": "https://your-key@o123.ingest.sentry.io/456"
}
```

That's it. Traces flow immediately. The Sentry CLI tool works even without a DSN — monitoring is optional.

### Config File Locations (first match wins)

1. `$PI_SENTRY_CONFIG` env var (explicit path)
2. `<project>/.pi/sentry.json[c]`
3. `~/.pi/agent/sentry.json[c]`

### Environment Variable Overrides

| Variable | Description |
|---|---|
| `PI_SENTRY_DSN` / `SENTRY_DSN` | Sentry DSN |
| `PI_SENTRY_TRACES_SAMPLE_RATE` | Sample rate (0–1) |
| `PI_SENTRY_RECORD_INPUTS` | Capture tool inputs (true/false) |
| `PI_SENTRY_RECORD_OUTPUTS` | Capture tool outputs (true/false) |
| `PI_SENTRY_ENABLE_METRICS` | Emit token usage metrics (true/false) |
| `PI_SENTRY_TAGS` | Custom tags (`key:value,key:value`) |
| `SENTRY_ENVIRONMENT` | Environment name |
| `SENTRY_RELEASE` | Release version |

### Full Config Reference

```json
{
  "dsn": "https://...",
  "tracesSampleRate": 1,
  "environment": "production",
  "release": "1.0.0",
  "debug": false,
  "agentName": "my-agent",
  "projectName": "my-project",
  "recordInputs": true,
  "recordOutputs": true,
  "maxAttributeLength": 12000,
  "includeMessageUsageSpans": true,
  "includeSessionEvents": true,
  "enableMetrics": false,
  "enableCLIInsights": false,
  "tags": {
    "team": "platform"
  }
}
```

## Sentry CLI Tool

Once installed, agents have a `sentry` tool for querying Sentry data. Auth is handled automatically — if the agent isn't authenticated, the tool opens a browser login flow and retries.

```
sentry issue list --limit 5
sentry issue view PROJ-123
sentry issue explain PROJ-123
sentry trace list --since 1h
sentry trace view <trace-id>
sentry span list <trace-id>
sentry log list
```

A bundled skill (`sentry-cli`) teaches agents the full command set. It's auto-discovered on install.

## Event Mapping

| pi event | Sentry span / action |
|---|---|
| `input` | End current trace, start a new one for the new interaction |
| `turn_start` | Track turn index |
| `model_select` | Update model/provider on active spans |
| `tool_execution_start` | Start `gen_ai.execute_tool` child span |
| `tool_execution_end` | End tool span with result/error status |
| `message_start` (assistant) | Start `gen_ai.request` span (measures LLM latency) |
| `message_end` (assistant) | End request span, attach token usage and content |
| `turn_end` | Flush completed trace to Sentry |
| `session_shutdown` | Close all open spans, flush, shut down client |
| `extension_error` | Capture exception from any extension handler crash |

## Development

```bash
git clone https://github.com/HazAT/pi-sentry && cd pi-sentry
npm install

# Run without installing
pi -e ./pi-extension/index.ts

# Checks (all must pass before commit)
vp check       # format + lint + typecheck
vp test        # run tests
```

## License

MIT
