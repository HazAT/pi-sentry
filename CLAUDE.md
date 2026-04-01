# Sentry Extension

Sentry observability extension for [pi](https://github.com/badlogic/pi-mono). Instruments agent sessions as distributed traces and provides a `sentry` tool for querying Sentry data.

## Structure

```
pi-extension/          ← TypeScript source (extension + sentry CLI wrapper)
  index.ts             ← Main extension: config loading, event wiring, Sentry init
  config.ts            ← Config loading, interfaces, defaults, env overrides
  helpers.ts           ← Pure utility functions (logger, naming, token math, type guards)
  tool.ts              ← Sentry CLI tool definition (render + execute with auth retry)
  tracing.ts           ← SessionTracer class: span lifecycle and event handling
  sentry-cli.ts        ← Thin wrapper: runs `npx sentry@latest <command>`
  serialize.ts         ← Attribute redaction/truncation
  __tests__/           ← Vitest tests (run via `vp test`)
skills/                ← Auto-discovered via package.json "pi.skills"
  sentry/              ← Setup wizard skill
  sentry-cli/          ← Teaches agents to use the sentry tool
scripts/               ← Utility scripts
```

## Verify

```bash
vp check       # format + lint + type check — always run after changes
vp test        # run tests
```

Individual checks:
```bash
vp fmt          # oxfmt — auto-format in place
vp lint         # oxlint — fast linter
npm run typecheck  # TypeScript type checking
vp test --watch # run tests in watch mode
```

All checks must pass before committing (enforced by pre-commit hook). No build step — pi loads TypeScript directly.

## Key Conventions

### Dependencies

- `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@sinclair/typebox` are **devDependencies only** — provided by pi at runtime. Never add them to `dependencies`.
- `@sentry/node-core`, `@sentry/core`, `strip-json-comments` are real runtime dependencies.
- `vite-plus` is the unified toolchain — provides vitest, oxlint, oxfmt via `vp` commands.

### Extension Architecture

- The `sentry` tool is registered **before** the DSN/config check — it works independently of monitoring.
- Monitoring (tracing, spans) only activates when a DSN is configured in `.pi/sentry.json`.
- Tool rendering uses `Text` and `Container` from `@mariozechner/pi-tui`. Cast `context.state` as `Partial<SentryRenderState>` since pi initializes it as `{}`.
- **`index.ts`** is thin wiring — it loads config, inits Sentry, registers the tool, creates a `SessionTracer`, and wires `pi.on()` events to tracer methods.
- **`tracing.ts`** (`SessionTracer` class) owns all span state and lifecycle. It has no dependency on pi's `ExtensionAPI`.
- **`tool.ts`** (`createSentryTool` factory) returns the tool config object. Only depends on `SentryCLI` and helpers.
- **`helpers.ts`** contains pure functions with no Sentry SDK imports.

### Config Fields

When adding a new config field, update all four places in `config.ts`:
1. `PluginConfig` interface (optional)
2. `ResolvedPluginConfig` interface (required)
3. `DEFAULTS` object
4. `normalizeConfig()` return value
5. `addEnvOverrides()` with a `PI_SENTRY_*` env var

### Skills

Skills live in `skills/<name>/SKILL.md` with YAML frontmatter (`name`, `description`). They teach agents how to use features — always reference the `sentry` tool call syntax, never raw CLI via bash.

### Testing

Tests live in `pi-extension/__tests__/` and run via `vp test` (Vitest bundled in vite-plus). High-value tests cover:
- `serialize.test.ts` — redaction, truncation, edge cases
- `config.test.ts` — validation, defaults, env overrides
- `sentry-cli.test.ts` — command parsing
- `helpers.test.ts` — token math, subagent detection, type guards

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
