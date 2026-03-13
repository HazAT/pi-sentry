# pi-sentry-monitor

Sentry AI Monitoring extension for [pi coding agent](https://github.com/nichochar/pi) sessions and tool calls.

Mirrors what [opencode-sentry-monitor](https://github.com/getsentry/opencode-sentry-monitor) does for OpenCode — tracks agent sessions, tool executions, token usage, and errors as Sentry traces.

## Trace Hierarchy

```
gen_ai.invoke_agent (session span)
├── gen_ai.execute_tool (per tool call)
│   ├── gen_ai.tool.input  (if recordInputs enabled)
│   └── gen_ai.tool.output (if recordOutputs enabled)
└── gen_ai.request (per assistant message)
    └── token usage attributes (input, output, cached)
```

## Installation

**Global** (applies to all projects):
```bash
pi install npm:pi-sentry-monitor
```

**Project-local** (checked into the repo, shared with teammates):
```bash
pi install npm:pi-sentry-monitor -l
```

Then run `/reload` in pi to activate without restarting.

A companion skill is included — once installed, ask pi to "set up Sentry monitoring" and it will walk through creating a Sentry project, configuring the DSN, and verifying traces are flowing.

## Configuration

Create `.pi/sentry-monitor.json` (or `.jsonc`) in your project:

```json
{
  "dsn": "https://your-key@o123.ingest.sentry.io/456"
}
```

### Config File Locations (searched in order)

1. Path in `PI_SENTRY_CONFIG` env var
2. `<cwd>/.pi/sentry-monitor.json[c]`
3. `~/.pi/agent/sentry-monitor.json[c]`

### Environment Variable Overrides

| Variable | Description |
|---|---|
| `PI_SENTRY_DSN` / `SENTRY_DSN` | Sentry DSN |
| `PI_SENTRY_TRACES_SAMPLE_RATE` | Sample rate (0-1) |
| `PI_SENTRY_RECORD_INPUTS` | Record tool inputs (true/false) |
| `PI_SENTRY_RECORD_OUTPUTS` | Record tool outputs (true/false) |
| `PI_SENTRY_ENABLE_METRICS` | Enable metrics (true/false) |
| `PI_SENTRY_TAGS` | Custom tags (format: `key:value,key:value`) |
| `SENTRY_ENVIRONMENT` | Environment name |
| `SENTRY_RELEASE` | Release version |

### Full Config Schema

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
  "tags": {
    "team": "platform"
  }
}
```

## Event Mapping

| pi event | Sentry span/action |
|---|---|
| `session_start` | Create root `gen_ai.invoke_agent` span |
| `session_shutdown` | End session span, flush Sentry |
| `model_select` | Track model/provider changes |
| `tool_execution_start` | Start `gen_ai.execute_tool` child span |
| `tool_execution_end` | End tool span, capture errors |
| `message_start` (assistant) | Open `gen_ai.request` span (captures real LLM latency) |
| `message_end` (assistant) | Close `gen_ai.request` span, attach token usage + content |
| `agent_end` | Flush pending data to Sentry |

## Development

```bash
git clone https://github.com/sergical/pi-sentry-monitor && cd pi-sentry-monitor
npm install
npm run build

# Install local copy for testing
pi install ./path/to/pi-sentry-monitor
# or test without installing (ephemeral)
pi -e ./dist/index.js
```

## License

MIT
