---
name: pi-sentry-monitor
description: Set up Sentry observability for pi coding agent sessions. Use when someone says "set up Sentry monitoring", "add observability to pi", "configure pi-sentry-monitor", "trace pi sessions", "monitor pi with Sentry", or "instrument pi". Interactively collects DSN and preferences, then writes the config file.
---

# pi-sentry-monitor Setup Wizard

You are setting up the `pi-sentry-monitor` extension, which instruments pi agent sessions as distributed traces in Sentry.

## What you will do

1. Check whether the extension is installed — install it if not
2. Check for an existing config file — offer to update it if found
3. Ask the user for their DSN and configuration preferences
4. Write the config file
5. Verify everything looks correct

---

## Step 1 — Check extension install status

Run:
```bash
pi list 2>/dev/null | grep pi-sentry-monitor || echo "NOT_INSTALLED"
```

If not installed, tell the user and ask whether to install globally or project-local, then run the appropriate command:
```bash
pi install npm:pi-sentry-monitor          # global
pi install npm:pi-sentry-monitor -l       # project-local
```

Tell them to run `/reload` after installing (or offer to do it).

---

## Step 2 — Check for existing config

Look for an existing config in these locations (in order):
1. `.pi/sentry-monitor.json` or `.pi/sentry-monitor.jsonc`
2. `~/.pi/agent/sentry-monitor.json` or `~/.pi/agent/sentry-monitor.jsonc`

Use the `read` tool to check. If one exists, show the current config and ask: **"A config already exists — do you want to update it or leave it as-is?"**

---

## Step 3 — Gather configuration via questions

Use the `/answer` command to ask all questions at once. Ask:

1. **Sentry DSN** *(required)* — "Paste your DSN from Sentry → Project Settings → Client Keys. Looks like: `https://abc123@o456.ingest.sentry.io/789`"

2. **Config scope** — "Should this config be project-local (`.pi/sentry-monitor.json`) or global (`~/.pi/agent/sentry-monitor.json`)? Project-local means it only applies here; global applies to all your pi sessions."

3. **Environment** *(optional)* — "What environment name should appear on traces? e.g. `development`, `production`. Leave blank to omit."

4. **Agent/project name** *(optional)* — "What name should appear on spans? Defaults to the project directory name (`basename $PWD`). Leave blank to use the default."

5. **Record tool inputs** — "Record tool input arguments as span attributes? This lets you see exactly what args were passed to each tool call in Sentry. (yes/no, default: yes)"

6. **Record tool outputs** — "Record tool output as span attributes? This lets you see what tools returned in Sentry. Can be verbose. (yes/no, default: yes)"

7. **Traces sample rate** — "What fraction of sessions should be traced? `1` = 100%, `0.5` = 50%. For personal use, `1` is recommended. (default: 1)"

8. **Custom tags** *(optional)* — "Any custom tags to attach to every span? e.g. `team:platform,project:myapp`. Leave blank to skip."

---

## Step 4 — Write the config file

Build the config object from the answers. Only include fields that differ from defaults or were explicitly provided. Defaults are:
- `tracesSampleRate`: 1
- `recordInputs`: true
- `recordOutputs`: true

Example minimal config (just DSN):
```json
{
  "dsn": "https://abc123@o456.ingest.sentry.io/789"
}
```

Example full config:
```json
{
  "dsn": "https://abc123@o456.ingest.sentry.io/789",
  "environment": "development",
  "agentName": "my-agent",
  "projectName": "my-project",
  "recordInputs": true,
  "recordOutputs": false,
  "tracesSampleRate": 0.5,
  "tags": {
    "team": "platform"
  }
}
```

Write the file using the `write` tool to the path the user chose.

---

## Step 5 — Confirm and verify

Show the user the config that was written and where it was saved.

Then tell them:
> "The extension will pick up this config on the next session start. Run `/reload` now to apply it to this session, or it will activate automatically next time you start pi."

Offer to run a quick trace verification using the Sentry CLI if it's available:
```bash
sentry --version 2>/dev/null && echo "available" || echo "not_available"
```

If available, after they've run a few commands, offer to run:
```bash
sentry trace list <org>/<project> --limit 5
```
...to confirm traces are flowing.

---

## Config reference (for your own reference during the conversation)

| Field | Default | Description |
|-------|---------|-------------|
| `dsn` | required | Sentry DSN |
| `environment` | — | Environment tag |
| `agentName` | project dirname | Name on spans |
| `projectName` | project dirname | Name on spans |
| `recordInputs` | `true` | Capture tool input args |
| `recordOutputs` | `true` | Capture tool output |
| `tracesSampleRate` | `1` | 0–1 sampling rate |
| `maxAttributeLength` | `12000` | Max chars per span attribute |
| `enableMetrics` | `false` | Emit Sentry token usage metrics |
| `tags` | `{}` | Custom tags on every span |

## Troubleshooting

**No traces appearing** — Check the DSN, ensure `tracesSampleRate` is `1`, look for `[pi-sentry-monitor]` errors in pi console output. Traces flush at the end of each agent turn.

**Spans show ~1ms duration** — Upgrade to `pi-sentry-monitor` >= 0.1.0. Earlier builds had a timing bug where `gen_ai.request` spans were not measuring real LLM latency.

**Extension not loading** — Run `/reload` or restart pi. Confirm with `pi list | grep pi-sentry-monitor`.
