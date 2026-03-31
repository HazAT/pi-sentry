---
name: sentry-cli
description: Query Sentry data — issues, traces, spans, logs. Use when asked to "check Sentry", "look at issues", "view traces", "debug with Sentry", "what's happening in Sentry", "check my traces", "look at errors", "find my trace", or "query Sentry".
---

# Sentry CLI Skill

Use the `sentry` tool to query Sentry. The `command` parameter is exactly what you'd type after `sentry` on the command line.

```typescript
sentry({ command: "issue list --limit 5" })
sentry({ command: "trace view <trace-id> --json" })
```

Full docs: https://cli.sentry.dev

---

## Quick Reference

| Task | Tool call |
|------|-----------|
| Check auth | `sentry({ command: "auth status" })` |
| List issues | `sentry({ command: "issue list" })` |
| View issue | `sentry({ command: "issue view <id>" })` |
| Explain issue with AI | `sentry({ command: "issue explain <id>" })` |
| Get fix plan | `sentry({ command: "issue plan <id>" })` |
| List traces | `sentry({ command: "trace list" })` |
| View trace | `sentry({ command: "trace view <trace-id>" })` |
| List spans in trace | `sentry({ command: "span list <trace-id>" })` |
| View span | `sentry({ command: "span view <trace-id>/<span-id>" })` |
| List logs | `sentry({ command: "log list" })` |
| View trace logs | `sentry({ command: "trace logs <trace-id>" })` |
| List dashboards | `sentry({ command: "dashboard list" })` |
| View dashboard | `sentry({ command: "dashboard view <id>" })` |
| Raw API call | `sentry({ command: "api /projects/" })` |
| Browse API schema | `sentry({ command: "schema" })` |

---

## Auth

Check auth status before querying:

```typescript
sentry({ command: "auth status" })
```

If not authenticated, the tool will automatically open the user's browser for login when you run any command. Just run your command — auth is handled for you.

You can also explicitly trigger login:

```typescript
sentry({ command: "auth login" })
```

---

## Issues

```typescript
// List recent issues
sentry({ command: "issue list --limit 10" })

// Filter by project, status, date
sentry({ command: "issue list --project my-project --status unresolved --limit 20" })

// View full issue details
sentry({ command: "issue view PROJ-123" })

// AI explanation
sentry({ command: "issue explain PROJ-123" })

// AI-generated fix plan
sentry({ command: "issue plan PROJ-123" })
```

Use `--json` to get machine-readable output. Use `--fields` to limit columns:

```typescript
sentry({ command: "issue list --json --fields id,title,status,firstSeen" })
```

---

## Traces & Spans

```typescript
// List recent traces
sentry({ command: "trace list --limit 10" })

// Filter by project and time window
sentry({ command: "trace list --project my-project --since 1h --limit 20" })

// View full trace (tree of spans)
sentry({ command: "trace view abc123def456" })

// JSON for programmatic use
sentry({ command: "trace view abc123def456 --json" })

// List spans in a trace
sentry({ command: "span list abc123def456" })

// View a specific span
sentry({ command: "span view abc123def456/span-id-here" })
```

---

## Logs

```typescript
// List recent logs
sentry({ command: "log list --limit 20" })

// Filter by project
sentry({ command: "log list --project my-project --limit 50" })

// Logs associated with a trace
sentry({ command: "trace logs abc123def456" })
```

---

## Finding Your Own Traces

The Sentry extension instruments pi agent sessions as distributed traces. Each trace has:

- **`gen_ai.agent.name`** — set to the project directory name (or `agentName` in config)
- **Project** — configured in `.pi/sentry.json`

To find traces from the current session:

```typescript
// Find recent traces by project
sentry({ command: "trace list --project my-project --since 1h --limit 10" })

// Inspect a trace (see all tool calls as spans)
sentry({ command: "trace view <trace-id>" })

// View logs captured during a trace
sentry({ command: "trace logs <trace-id>" })
```

The trace root span is named after the first user message. Each tool call (bash, read, write, edit) becomes a child span with inputs and outputs as attributes.

If traces aren't appearing:
1. Check `sentry({ command: "auth status" })` — are you authenticated?
2. Confirm the Sentry extension is installed: `pi list | grep sentry`
3. Traces flush at the end of each turn — wait for the current turn to complete
4. Check that DSN is correct in `.pi/sentry.json` or `~/.pi/agent/sentry.json`

---

## Dashboards

```typescript
// List dashboards
sentry({ command: "dashboard list" })

// View a dashboard
sentry({ command: "dashboard view <id>" })

// Create a dashboard (opens browser)
sentry({ command: "dashboard create -w" })
```

---

## Raw API Access

For anything not covered by named commands:

```typescript
// Call any Sentry REST API endpoint
sentry({ command: "api /projects/" })
sentry({ command: "api /organizations/my-org/issues/?query=is:unresolved" })

// Browse available endpoints
sentry({ command: "schema" })
```

---

## Useful Flags

| Flag | Effect |
|------|--------|
| `--json` | Machine-readable JSON output |
| `--fields id,title,status` | Limit output columns |
| `--limit N` | Cap result count |
| `--since 1h` / `--since 24h` | Time window filter |
| `--project <slug>` | Filter by project |
| `-w` | Open result in browser |

**Always use `--json` when parsing output programmatically.**

Example — get issue IDs and titles only:

```typescript
sentry({ command: "issue list --json --fields id,title --limit 5" })
```
