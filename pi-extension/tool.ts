import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToVisualLines, keyHint } from "@mariozechner/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { SentryCLI } from "./sentry-cli.js";
import { isAuthError, formatSentryDuration } from "./helpers.js";

type SentryRenderState = {
  startedAt: number | undefined;
  endedAt: number | undefined;
  interval: NodeJS.Timeout | undefined;
};

const SENTRY_PREVIEW_LINES = 5;

export function createSentryTool(cli: SentryCLI) {
  return {
    name: "sentry" as const,
    label: "Sentry CLI",
    description:
      "Run Sentry CLI commands. Pass the command string exactly as you would after 'sentry' on the command line.",
    promptSnippet:
      "sentry - Run Sentry CLI commands (issue list, trace view, log list, auth status, etc.)",
    promptGuidelines: [
      "Before using the sentry tool, load the `sentry` skill once for full usage guidance, workflows, and examples.",
      "If the user asks to check Sentry, inspect traces, issues, spans, logs, dashboards, or events, invoke the `sentry` skill before the first sentry tool call.",
      "The sentry tool runs Sentry CLI commands. Pass the full command after 'sentry', e.g. sentry({ command: \"issue list --limit 5 --json\" })",
      "Use --json flag for machine-readable output when you need to parse results",
      "Use --fields to limit output columns and reduce noise",
      "Common commands: auth status, issue list, issue view <id>, trace list, trace view <id>, span list, log list, auth login",
    ],
    parameters: Type.Object({
      command: Type.String({
        description:
          "Sentry CLI command (everything after 'sentry'). Examples: 'issue list --limit 5', 'trace view <id> --json', 'auth status'",
      }),
    }),

    renderCall(args: { command: string }, theme: Theme, context: any) {
      const state = context.state as Partial<SentryRenderState>;
      if (context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
        state.endedAt = undefined;
      }
      const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
      const command = args?.command ?? "...";
      text.setText(theme.fg("toolTitle", theme.bold(`▲ sentry ${command}`)));
      return text;
    },

    renderResult(result: any, options: any, theme: Theme, context: any) {
      const state = context.state as Partial<SentryRenderState>;
      if (state.startedAt !== undefined && options.isPartial && !state.interval) {
        state.interval = setInterval(() => context.invalidate(), 1000);
      }
      if (!options.isPartial || context.isError) {
        state.endedAt ??= Date.now();
        if (state.interval) {
          clearInterval(state.interval);
          state.interval = undefined;
        }
      }
      const component = (context.lastComponent as Container) ?? new Container();
      component.clear();
      const textContent = result.content
        .filter((c: any): c is { type: "text"; text: string } => c.type === "text")
        .map((c: any) => c.text)
        .join("\n")
        .trim();
      if (textContent) {
        const styledOutput = textContent
          .split("\n")
          .map((line: string) => theme.fg("toolOutput", line))
          .join("\n");
        if (context.expanded) {
          component.addChild(new Text(`\n${styledOutput}`, 0, 0));
        } else {
          component.addChild({
            render: (width: number) => {
              const preview = truncateToVisualLines(styledOutput, SENTRY_PREVIEW_LINES, width);
              if (preview.skippedCount > 0) {
                const hint =
                  theme.fg("muted", `... (${preview.skippedCount} earlier lines,`) +
                  ` ${keyHint("app.tools.expand", "to expand")})`;
                return ["", truncateToWidth(hint, width, "..."), ...preview.visualLines];
              }
              return ["", ...preview.visualLines];
            },
            invalidate: () => {},
          });
        }
      }
      if (state.startedAt !== undefined) {
        const label = options.isPartial ? "Elapsed" : "Took";
        const endTime = state.endedAt ?? Date.now();
        component.addChild(
          new Text(
            `\n${theme.fg("muted", `${label} ${formatSentryDuration(endTime - state.startedAt)}`)}`,
            0,
            0,
          ),
        );
      }
      component.invalidate();
      return component;
    },

    async execute(
      _toolCallId: string,
      params: { command: string },
      signal: AbortSignal | undefined,
    ) {
      const result = await cli.run(params.command, { timeout: 30_000 });
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");

      // Check if auth is needed
      if (result.code !== 0 && isAuthError(output)) {
        if (signal?.aborted) {
          return {
            content: [{ type: "text" as const, text: output || "(no output)" }],
            isError: true,
            details: undefined,
          };
        }

        const parts: string[] = [];
        parts.push("🔐 Not authenticated with Sentry.\n");
        parts.push("🌐 Opening your browser to log in...");
        parts.push("   Please approve the request in your browser.\n");

        const authResult = await cli.authLogin();

        if (authResult.code !== 0) {
          const authOutput = [authResult.stdout, authResult.stderr].filter(Boolean).join("\n");
          parts.push(`❌ Authentication failed:\n${authOutput}`);
          return {
            content: [{ type: "text" as const, text: parts.join("\n") }],
            isError: true,
            details: undefined,
          };
        }

        parts.push("✅ Authenticated successfully!\n");
        parts.push(`▲ sentry ${params.command}`);

        const retryResult = await cli.run(params.command, { timeout: 30_000 });
        const retryOutput = [retryResult.stdout, retryResult.stderr].filter(Boolean).join("\n");
        parts.push(retryOutput || "(no output)");

        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          isError: retryResult.code !== 0,
          details: undefined,
        };
      }

      return {
        content: [{ type: "text" as const, text: output || "(no output)" }],
        isError: result.code !== 0,
        details: undefined,
      };
    },
  };
}
