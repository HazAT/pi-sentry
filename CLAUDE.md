# pi-sentry

Sentry observability extension for [pi](https://github.com/badlogic/pi-mono). Instruments agent sessions as distributed traces and provides a `sentry` tool for querying Sentry data.

## Structure

```
pi-extension/          ← TypeScript source (extension + sentry CLI wrapper)
  index.ts             ← Main extension: monitoring hooks + sentry tool registration
  config.ts            ← Config loading, interfaces, defaults, env overrides
  sentry-cli.ts        ← Thin wrapper: runs `npx sentry@latest <command>`
  serialize.ts         ← Attribute redaction/truncation
skills/                ← Auto-discovered via package.json "pi.skills"
  pi-sentry-monitor/   ← Setup wizard skill
  sentry-cli/          ← Teaches agents to use the sentry tool
dist/                  ← Build output (git-ignored)
scripts/               ← Utility scripts
```

## Build & Verify

```bash
npm run typecheck   # always run after changes
npm run build       # compile to dist/
```

Both must pass before committing.

## Key Conventions

### Dependencies

- `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@sinclair/typebox` are **devDependencies only** — provided by pi at runtime. Never add them to `dependencies`.
- `@sentry/node-core`, `@sentry/core`, `strip-json-comments` are real runtime dependencies.

### Extension Architecture

- The `sentry` tool is registered **before** the DSN/config check — it works independently of monitoring.
- Monitoring (tracing, spans) only activates when a DSN is configured in `.pi/sentry.json`.
- Tool rendering uses `Text` and `Container` from `@mariozechner/pi-tui`. Cast `context.state` as `Partial<SentryRenderState>` since pi initializes it as `{}`.

### Config Fields

When adding a new config field, update all four places in `config.ts`:
1. `PluginConfig` interface (optional)
2. `ResolvedPluginConfig` interface (required)
3. `DEFAULTS` object
4. `normalizeConfig()` return value
5. `addEnvOverrides()` with a `PI_SENTRY_*` env var

### Skills

Skills live in `skills/<name>/SKILL.md` with YAML frontmatter (`name`, `description`). They teach agents how to use features — always reference the `sentry` tool call syntax, never raw CLI via bash.

## Demo & Testing

Reset Sentry CLI auth to replay the auto-login flow:
```bash
./scripts/reset-sentry-auth.sh
```

Test the extension locally without installing:
```bash
pi -e ./pi-extension/index.ts
```

## Naming

- **Agent name**: defaults to `pi` (not the project directory). Subagents show as `pi/<agent>`.
- **Project name**: defaults to `basename(cwd)`. Used for `pi.project.name` span attribute.
