---
name: pi-sentry-monitor
description: Set up Sentry observability for pi coding agent sessions. Use when someone says "set up Sentry monitoring", "add observability to pi", "configure pi-sentry-monitor", "trace pi sessions", "monitor pi with Sentry", or "instrument pi". Interactively collects DSN and preferences, then writes the config file.
---

# pi-sentry-monitor Setup Wizard

You are setting up the `pi-sentry-monitor` extension, which instruments pi agent sessions as distributed traces in Sentry.

## What you will do

1. Check whether the extension is installed — install it if not
2. Check for an existing config file — offer to update it if found
3. Auto-detect project name and developer identity
4. Ask the user a small set of questions
5. Write the config file
6. Confirm and offer to verify

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

## Step 3 — Auto-detect context

Before asking questions, silently gather:

**Project name:**
```bash
basename "$PWD"
```

**Developer identity** — try each in order, use the first that returns a value:
```bash
gh api user --jq .login 2>/dev/null        # GitHub username (most useful for team attribution)
git config user.email 2>/dev/null           # fallback: git email
git config user.name 2>/dev/null            # fallback: git name
whoami                                      # last resort
```

Hold onto both — you'll use them to pre-fill answers and write the config.

---

## Step 4 — Ask questions

Use `/answer` to gather everything at once. Show the auto-detected values as defaults so the user only needs to change what's wrong.

Ask:

1. **Sentry DSN** *(required)* — "Paste your DSN from Sentry → Project Settings → Client Keys. Looks like: `https://abc123@o456.ingest.sentry.io/789`"

2. **Config scope** — "Should this be project-local (`.pi/sentry.json`) or global (`~/.pi/agent/sentry.json`)? Project-local applies only here; global applies to all pi sessions on this machine."

3. **Agent/project name** — "We'll use `<detected-project-name>` as the agent name on Sentry spans (from your current directory). Want to change it, or is that good?"

4. **Developer tag** — "We detected your identity as `<detected-identity>`. Want to tag your traces with this? It lets you filter and break down Sentry data by developer when multiple people share the same Sentry project. (yes/no, default: yes)"

5. **Environment** *(optional)* — "What environment name should appear on traces? e.g. `development`, `production`. Leave blank to omit."

6. **Record tool inputs/outputs** — "Record tool inputs and outputs as span attributes in Sentry? Useful for debugging but can be verbose. (yes/no, default: yes)"

7. **Traces sample rate** *(optional)* — "What fraction of sessions to trace? `1` = 100%, `0.5` = 50%. Leave blank for the default (1)."

---

## Step 5 — Write the config file

Build the config from the answers. Only include fields that differ from defaults or were explicitly set. Defaults are: `tracesSampleRate: 1`, `recordInputs: true`, `recordOutputs: true`.

If the user confirmed the developer tag, add it under `tags`:
```json
{
  "tags": {
    "developer": "<detected-identity>"
  }
}
```

If the user also provided other custom tags, merge them in.

For the agent name: only include `agentName` if the user explicitly changed it from the auto-detected value. The extension already defaults to `basename $PWD`, so there's no need to write it unless overridden.

Example minimal config:
```json
{
  "dsn": "https://abc123@o456.ingest.sentry.io/789",
  "tags": {
    "developer": "sergical"
  }
}
```

Example fuller config:
```json
{
  "dsn": "https://abc123@o456.ingest.sentry.io/789",
  "environment": "development",
  "agentName": "custom-name",
  "recordOutputs": false,
  "tracesSampleRate": 0.5,
  "tags": {
    "developer": "sergical"
  }
}
```

Write the file using the `write` tool to the path the user chose.

---

## Step 6 — Confirm and verify

Show the user the config that was written and where it was saved.

Then tell them:
> "Run `/reload` to apply this to the current session, or it will activate automatically next time pi starts."

If the Sentry CLI is available (`sentry --version`), offer to check for incoming traces after they've run a few commands:
```bash
sentry trace list <org>/<project> --limit 5
```

---

## Config reference

| Field | Default | Description |
|-------|---------|-------------|
| `dsn` | required | Sentry DSN |
| `environment` | — | Environment tag |
| `agentName` | `basename $PWD` | Name shown on spans |
| `projectName` | `basename $PWD` | Name shown on spans |
| `recordInputs` | `true` | Capture tool input args as span attributes |
| `recordOutputs` | `true` | Capture tool output as span attributes |
| `tracesSampleRate` | `1` | Fraction of sessions to trace (0–1) |
| `maxAttributeLength` | `12000` | Max chars per span attribute |
| `enableMetrics` | `false` | Emit Sentry token usage metrics |
| `tags` | `{}` | Custom tags on every span — great for `developer`, `team`, `env` |

## Troubleshooting

**No traces appearing** — Check the DSN, ensure `tracesSampleRate` is `1`, look for `[pi-sentry-monitor]` in pi console output. Traces flush at the end of each agent turn.

**Spans show ~1ms duration** — Upgrade to `pi-sentry-monitor` >= 0.1.0. Earlier builds had a timing bug.

**Extension not loading** — Run `/reload` or restart pi. Confirm with `pi list | grep pi-sentry-monitor`.
