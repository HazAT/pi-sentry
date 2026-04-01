---
name: sentry
description: Guide for using the Sentry CLI to inspect issues, events, traces, spans, logs, dashboards, organizations, projects, and authenticated API data from this repo via the `sentry` tool.
---

# Sentry Skill

Use the `sentry` tool to run the Sentry CLI. The `command` value is exactly what you would type after `sentry` on the command line.

```typescript
sentry({ command: "issue list --limit 5" });
sentry({ command: "trace view abc123def456 --json" });
```

## Agent Guidance

### Key principles

- Just run the command. Do not require `auth status` before every read operation.
- Prefer CLI commands over raw API calls. Use `issue`, `trace`, `span`, `log`, `dashboard`, `org`, and `project` commands before `api`.
- Use `schema` to explore the API when you need an endpoint the dedicated commands do not cover.
- Use `issue view PROJ-123` directly when you already know the short ID.
- Use `--json` for machine-readable output and `--fields` to keep results small.
- The CLI can auto-detect org and project context. Only add explicit scoping when detection fails or resolves to the wrong target.

### Design principles

The CLI follows `gh`-style conventions:

- Subcommands are noun-first, for example `issue list`, `trace view`, `org view`.
- `--json` is for structured output.
- `--fields` selects fields.
- `-q` and `--query` apply Sentry search syntax.
- `-n` and `--limit` cap results.
- `-w` and `--web` open supported views in the browser.

For raw HTTP access, `api` behaves like a small `curl` wrapper:

- `--method` sets the HTTP method.
- `--data` sends a request body.
- `--header` adds headers.

### Context window tips

- Prefer `--json --fields ...` over wide human-readable tables.
- Use `--limit` aggressively.
- Prefer direct lookup by ID over list-then-filter when you already have the identifier.
- Use `--period` or `-t` for time filtering. Do not teach or rely on `--since`.

### Safety rules

- Confirm with the user before destructive commands such as `project delete` or `trial start`.
- For mutations, verify the org and project context before taking the next action.
- Never print or store auth tokens.
- If auto-detection picks the wrong org or project, rerun with explicit positional scoping.

## Workflow patterns

### Investigate an issue

```typescript
// 1. Find recent unresolved issues
sentry({ command: 'issue list --query "is:unresolved" --limit 5' });

// 2. View a specific issue
sentry({ command: "issue view PROJ-123" });

// 3. Ask for AI root cause analysis
sentry({ command: "issue explain PROJ-123" });

// 4. Ask for a fix plan
sentry({ command: "issue plan PROJ-123" });
```

### Explore traces and performance

```typescript
// 1. List recent traces
sentry({ command: "trace list --limit 5" });

// 2. View one trace
sentry({ command: "trace view abc123def456" });

// 3. List spans in the trace
sentry({ command: "span list abc123def456" });

// 4. View logs associated with the trace
sentry({ command: "trace logs abc123def456" });
```

### Stream logs

```typescript
sentry({ command: "log list --follow" });
sentry({ command: 'log list --query "severity:error"' });
```

### Explore the API schema

```typescript
sentry({ command: "schema" });
sentry({ command: "schema issues" });
sentry({
  command:
    'schema "GET /api/0/organizations/{organization_id_or_slug}/issues/"',
});
```

### Arbitrary API access

```typescript
sentry({ command: "api /api/0/organizations/my-org/" });
sentry({
  command:
    `api /api/0/organizations/my-org/projects/ --method POST --data '{"name":"new-project","platform":"python"}'`,
});
```

## Quick reference

### Time filtering

Use `--period` or `-t`:

```typescript
sentry({ command: "trace list --period 1h" });
sentry({ command: "span list --period 24h" });
sentry({ command: "span list -t 7d" });
```

### Explicit org and project scoping

Org and project are positional when you need to override auto-detection:

```typescript
sentry({ command: "trace list my-org/my-project --limit 5" });
sentry({ command: "issue list my-org/my-project --limit 10" });
sentry({ command: "span list my-org/my-project/abc123def456" });
```

### Listing spans in a trace

```typescript
sentry({ command: "span list abc123def456" });
sentry({ command: "span list my-org/my-project/abc123def456" });
```

### Structured output

```typescript
sentry({
  command:
    "issue list --json --fields shortId,title,priority,level,status --limit 10",
});
sentry({ command: "trace view abc123def456 --json" });
```

### Browser views

```typescript
sentry({ command: "issue view PROJ-123 --web" });
sentry({ command: "dashboard view <dashboard-id> --web" });
```

## Repo-specific note

This repo emits distributed traces for agent sessions. To inspect recent activity from the extension:

```typescript
sentry({ command: "trace list --period 1h --limit 10" });
sentry({ command: "trace view <trace-id>" });
sentry({ command: "trace logs <trace-id>" });
```

If the inferred target is wrong, rerun with explicit positional scoping:

```typescript
sentry({ command: "trace list my-org/my-project --period 1h --limit 10" });
```

## Dashboard layout

Sentry dashboards use a 6-column grid.

- `big_number` is width 2 and height 1, so three fit in one row.
- `line`, `area`, and `bar` are width 3 and height 2, so two fit in one row.
- `table` is width 6 and height 2, so it takes a full row.

Use common display types unless the user explicitly wants a specialized or internal widget.

## Common mistakes

- Do not use numeric issue IDs when the user has a short ID like `PROJ-123`.
- Do not pre-authenticate unless you actually need to change accounts or diagnose auth.
- Do not skip `--json` when you need to parse the result.
- Do not force explicit org and project flags when auto-detection is likely to work.
- Do not treat `--query` as free text. It uses Sentry search syntax.
- Do not teach `--since`; use `--period` or `-t`.
- Do not jump to `api` if a dedicated CLI command already exists.
