import type { ExtensionAPI, ExtensionUIContext, Theme } from "@mariozechner/pi-coding-agent";
import { truncateToVisualLines, keyHint } from "@mariozechner/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@mariozechner/pi-tui";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { createSentryCLI } from "./sentry-cli.js";
import * as Sentry from "@sentry/node-core/light";
import { initWithoutDefaultIntegrations, type LightNodeClient } from "@sentry/node-core/light";
import { setConversationId } from "@sentry/core";
import { basename, dirname } from "node:path";
import { loadPluginConfig, type PluginLogger, type ResolvedPluginConfig } from "./config.js";
import { serializeAttribute } from "./serialize.js";

type SentrySpan = ReturnType<typeof Sentry.startInactiveSpan>;

let sentryInitialized = false;
let initializedDsn: string | null = null;

function createLogger(): PluginLogger {
  const service = "sentry";

  const write = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    extra?: Record<string, unknown>,
  ): void => {
    const prefix = `[${service}] ${message}`;
    if (level === "error") {
      console.error(prefix, extra ?? "");
      return;
    }
    if (level === "warn") {
      console.warn(prefix, extra ?? "");
      return;
    }
    if (level === "debug") {
      console.debug(prefix, extra ?? "");
      return;
    }
    console.info(prefix, extra ?? "");
  };

  return {
    debug: (message, extra) => write("debug", message, extra),
    info: (message, extra) => write("info", message, extra),
    warn: (message, extra) => write("warn", message, extra),
    error: (message, extra) => write("error", message, extra),
  };
}

function getProjectName(config: ResolvedPluginConfig, cwd: string): string {
  if (config.projectName && config.projectName.length > 0) {
    return config.projectName;
  }

  const guessed = basename(cwd);
  return guessed.length > 0 ? guessed : "pi-project";
}

/**
 * Detects the subagent name from CLI args when spawned by pi-subagents.
 *
 * pi-subagents writes each agent's system prompt to a temp file named
 * `{agent}.md` inside a `pi-subagent-XXXX/` directory, then passes it
 * as `--append-system-prompt /tmp/pi-subagent-XXXX/worker.md`. The agent
 * name is therefore recoverable from process.argv without any changes to
 * pi-subagents.
 */
function detectSubagentName(): string | undefined {
  const args = process.argv;
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== "--append-system-prompt") continue;
    const promptPath = args[i + 1];
    if (!promptPath) continue;

    // Only trust paths inside a pi-subagent-* temp dir (written by pi-subagents)
    const dirName = basename(dirname(promptPath));
    if (!dirName.startsWith("pi-subagent-")) continue;

    const fileName = basename(promptPath);
    const agentName = fileName.endsWith(".md") ? fileName.slice(0, -3) : fileName;

    // Agent names are word chars, dots, and hyphens (matches the sanitizer in pi-subagents)
    if (/^[\w.-]+$/.test(agentName) && agentName.length > 0) {
      return agentName;
    }
  }
  return undefined;
}

function getAgentName(config: ResolvedPluginConfig): string {
  if (config.agentName && config.agentName.length > 0) {
    return config.agentName;
  }

  const subagentName = detectSubagentName();
  if (subagentName) {
    return `pi/${subagentName}`;
  }

  return "pi";
}

function setSpanStatus(span: SentrySpan, isError: boolean): void {
  span.setStatus({ code: isError ? 2 : 1 });
}

function isAuthError(output: string): boolean {
  const lower = output.toLowerCase();
  return ["not logged in", "not authenticated", "401", "auth token", "unauthorized", "login required", "run 'sentry auth login'", "run `sentry auth login`"]
    .some(indicator => lower.includes(indicator));
}

function initSentry(config: ResolvedPluginConfig, logger: PluginLogger): LightNodeClient | undefined {
  if (sentryInitialized) {
    if (initializedDsn && initializedDsn !== config.dsn) {
      logger.warn("Sentry already initialized with different DSN", {
        initializedDsn,
        requestedDsn: config.dsn,
      });
    }
    return undefined;
  }

  const client = initWithoutDefaultIntegrations({
    dsn: config.dsn,
    tracesSampleRate: config.tracesSampleRate,
    environment: config.environment,
    release: config.release,
    debug: config.debug,
    sendDefaultPii: false,
    integrations: [
      Sentry.eventFiltersIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.requestDataIntegration(),
      Sentry.onUncaughtExceptionIntegration({
        exitEvenIfOtherHandlersAreRegistered: false,
      }),
      Sentry.onUnhandledRejectionIntegration({
        mode: "warn",
      }),
    ],
  });

  sentryInitialized = true;
  initializedDsn = config.dsn;
  return client;
}

function attachTokenUsage(
  span: SentrySpan,
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
  },
): { totalInput: number; totalOutput: number } {
  // gen_ai.usage.input_tokens must be TOTAL input tokens per OTel semantic conventions.
  // Pi's usage.input only contains non-cached tokens (Anthropic's input_tokens field),
  // so we add cache_read + cache_write to get the true total.
  // Sentry's cost formula computes: uncached = input_tokens - cached, so if we only
  // report non-cached here, the subtraction goes negative → negative cost.
  const totalInput = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  const totalOutput = usage.output ?? 0;
  if (totalInput > 0) {
    span.setAttribute("gen_ai.usage.input_tokens", totalInput);
  }
  if (totalOutput > 0) {
    span.setAttribute("gen_ai.usage.output_tokens", totalOutput);
  }
  if (typeof usage.cacheRead === "number") {
    span.setAttribute("gen_ai.usage.input_tokens.cached", usage.cacheRead);
  }
  if (typeof usage.cacheWrite === "number") {
    span.setAttribute("gen_ai.usage.input_tokens.cache_write", usage.cacheWrite);
  }
  // Derive total_tokens consistently from our computed totals
  const totalTokens = totalInput + totalOutput;
  if (totalTokens > 0) {
    span.setAttribute("gen_ai.usage.total_tokens", totalTokens);
  }
  return { totalInput, totalOutput };
}

function isAssistantMessage(msg: unknown): msg is AssistantMessage {
  if (!msg || typeof msg !== "object") {
    return false;
  }
  const m = msg as Record<string, unknown>;
  return m.role === "assistant" && typeof m.model === "string" && m.usage !== null && typeof m.usage === "object";
}

type SentryRenderState = {
  startedAt: number | undefined;
  endedAt: number | undefined;
  interval: NodeJS.Timeout | undefined;
};

const SENTRY_PREVIEW_LINES = 5;

function formatSentryDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export default async function piSentryMonitor(pi: ExtensionAPI) {
  const logger = createLogger();

  // Get cwd from first session_start event context, but load config eagerly with process.cwd()
  const cwd = process.cwd();

  // Register sentry CLI tool — always available regardless of DSN config
  const cli = createSentryCLI((cmd, args, opts) =>
    pi.exec(cmd, args, { timeout: opts?.timeout, cwd: opts?.cwd ?? cwd })
  );

  pi.registerTool({
    name: "sentry",
    label: "Sentry CLI",
    description: "Run Sentry CLI commands. Pass the command string exactly as you would after 'sentry' on the command line.",
    promptSnippet: "sentry - Run Sentry CLI commands (issue list, trace view, log list, auth status, etc.)",
    promptGuidelines: [
      "Before using the sentry tool, load the `sentry-cli` skill once for full usage guidance, workflows, and examples.",
      "The sentry tool runs Sentry CLI commands. Pass the full command after 'sentry', e.g. sentry({ command: \"issue list --limit 5 --json\" })",
      "Use --json flag for machine-readable output when you need to parse results",
      "Use --fields to limit output columns and reduce noise",
      "Common commands: auth status, issue list, issue view <id>, trace list, trace view <id>, span list, log list, auth login",
    ],
    parameters: Type.Object({
      command: Type.String({
        description: "Sentry CLI command (everything after 'sentry'). Examples: 'issue list --limit 5', 'trace view <id> --json', 'auth status'"
      }),
    }),
    renderCall(args: { command: string }, theme: Theme, context) {
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

    renderResult(result, options, theme: Theme, context) {
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
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();
      if (textContent) {
        const styledOutput = textContent.split("\n").map((line: string) => theme.fg("toolOutput", line)).join("\n");
        if (context.expanded) {
          component.addChild(new Text(`\n${styledOutput}`, 0, 0));
        } else {
          component.addChild({
            render: (width: number) => {
              const preview = truncateToVisualLines(styledOutput, SENTRY_PREVIEW_LINES, width);
              if (preview.skippedCount > 0) {
                const hint = theme.fg("muted", `... (${preview.skippedCount} earlier lines,`) +
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
        component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatSentryDuration(endTime - state.startedAt)}`)}`, 0, 0));
      }
      component.invalidate();
      return component;
    },

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const result = await cli.run(params.command, { timeout: 30_000 });
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");

      // Check if auth is needed
      if (result.code !== 0 && isAuthError(output)) {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: output || "(no output)" }], isError: true, details: undefined };
        }

        const parts: string[] = [];
        parts.push("🔐 Not authenticated with Sentry.\n");
        parts.push("🌐 Opening your browser to log in...");
        parts.push("   Please approve the request in your browser.\n");

        // Run auth login (opens browser, waits for approval)
        const authResult = await cli.run("auth login", { timeout: 120_000 });

        if (authResult.code !== 0) {
          const authOutput = [authResult.stdout, authResult.stderr].filter(Boolean).join("\n");
          parts.push(`❌ Authentication failed:\n${authOutput}`);
          return {
            content: [{ type: "text", text: parts.join("\n") }],
            isError: true,
            details: undefined,
          };
        }

        parts.push("✅ Authenticated successfully!\n");
        parts.push(`▲ sentry ${params.command}`);

        // Retry original command
        const retryResult = await cli.run(params.command, { timeout: 30_000 });
        const retryOutput = [retryResult.stdout, retryResult.stderr].filter(Boolean).join("\n");
        parts.push(retryOutput || "(no output)");

        return {
          content: [{ type: "text", text: parts.join("\n") }],
          isError: retryResult.code !== 0,
          details: undefined,
        };
      }

      return {
        content: [{ type: "text", text: output || "(no output)" }],
        isError: result.code !== 0,
        details: undefined,
      };
    },
  });

  const loaded = await loadPluginConfig(cwd, logger);

  if (!loaded) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.setStatus("sentry", "▲ Sentry (no DSN configured)");
    });
    return;
  }

  const config = loaded.config;
  const projectName = getProjectName(config, cwd);
  const agentName = getAgentName(config);

  const client = initSentry(config, logger);

  logger.info("Sentry observability extension enabled", {
    source: loaded.source,
    projectName,
    agentName,
    tracesSampleRate: config.tracesSampleRate,
    recordInputs: config.recordInputs,
    recordOutputs: config.recordOutputs,
  });


  // Background CLI insights state
  let sentryAuthenticated = false;
  let lastBackgroundQuery = 0;
  const BACKGROUND_QUERY_INTERVAL = 60_000;

  async function runBackgroundQuery() {
    uiContext?.setStatus("sentry", "▲ Sentry (checking issues...)");
    try {
      const result = await cli.run("issue list --limit 3 --json --fields shortId,title,level", { timeout: 15_000 });
      uiContext?.setStatus("sentry", "▲ Sentry (authenticated)");
      if (result.code === 0 && result.stdout.trim()) {
        pi.sendUserMessage(
          `[Sentry context] Recent issues:\n${result.stdout}`,
          { deliverAs: "steer" },
        );
      }
    } catch {
      uiContext?.setStatus("sentry", "▲ Sentry (authenticated)");
    }
  }

  // Single-session state (pi runs one session at a time)
  let sessionSpan: SentrySpan | undefined;
  let modelId = "unknown";
  let providerId: string = "unknown";
  const toolSpans = new Map<string, SentrySpan>();
  const requestSpans = new Map<number, SentrySpan>(); // keyed by message timestamp
  const completedMessages = new Set<number>(); // track by timestamp to avoid dupe usage spans
  let lastUserPrompt: string | undefined;
  let lastAssistantResponse: string | undefined;

  // Aggregate token usage across all request spans for the invoke_agent root span
  let aggregateInputTokens = 0;
  let aggregateOutputTokens = 0;

  // Status bar flash state
  let uiContext: ExtensionUIContext | undefined;
  let pendingSpanCount = 0;
  let statusFlashTimer: ReturnType<typeof setTimeout> | undefined;

  // Conversation tracking — links turns within the same session
  let sessionId: string | undefined;     // from pi's session manager, used as conversation ID
  let turnIndex = 0;                     // incremented on turn_start
  let previousTraceId: string | undefined; // trace ID of the previous turn for linking
  let turnHadToolCalls = false;            // tracks if current turn had tool executions

  function flashStatus(count: number): void {
    if (!uiContext || count === 0) return;
    if (statusFlashTimer) clearTimeout(statusFlashTimer);
    uiContext.setStatus("sentry", `▲ Sentry (sent ${count} event${count === 1 ? "" : "s"})`);
    statusFlashTimer = setTimeout(() => {
      uiContext?.setStatus("sentry", "▲ Sentry");
      statusFlashTimer = undefined;
    }, 5000);
  }

  function ensureSessionSpan(): SentrySpan {
    if (sessionSpan) {
      return sessionSpan;
    }

    // Each agent interaction gets its own trace.  startNewTrace() resets
    // the scope's propagation context so the span receives a fresh trace ID.
    // The conversation ID (set on the isolation scope) links all traces
    // from the same session together.
    sessionSpan = Sentry.startNewTrace(() => {
      // Re-apply conversation ID inside the new trace scope so it
      // propagates to all child spans.
      if (sessionId) {
        setConversationId(sessionId);
      }

      return Sentry.startInactiveSpan({
        op: "gen_ai.invoke_agent",
        name: `invoke_agent ${agentName}`,
        forceTransaction: true,
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": agentName,
          "gen_ai.request.model": modelId,
          "pi.model.provider": providerId,
          "pi.project.name": projectName,
          "pi.capture.session_events": config.includeSessionEvents,
          // Conversation tracking
          "pi.turn.index": turnIndex,
          ...(sessionId ? { "pi.session.id": sessionId } : {}),
          ...(lastUserPrompt && config.recordInputs ? {
            "gen_ai.request.messages": serializeAttribute(
              JSON.stringify([{ role: "user", content: lastUserPrompt }]),
              config.maxAttributeLength,
            ),
          } : {}),
          ...config.tags,
        },
      });
    });

    return sessionSpan;
  }

  function cleanupSession(): void {
    for (const [key, span] of toolSpans) {
      setSpanStatus(span, false);
      span.end();
      toolSpans.delete(key);
    }

    // Orphaned request spans (e.g. cancelled mid-stream) may still have
    // model "unknown" from when message_start created them.  Stamp them
    // with the latest known model before ending so they don't show up
    // without a model in Sentry.
    for (const [key, span] of requestSpans) {
      if (modelId !== "unknown") {
        span.setAttribute("gen_ai.request.model", modelId);
        span.setAttribute("gen_ai.response.model", modelId);
        span.setAttribute("pi.model.provider", providerId);
      }
      setSpanStatus(span, false);
      span.end();
      requestSpans.delete(key);
    }

    // Stamp the invoke_agent span with the final model, assistant response,
    // and aggregate token usage before ending.  The model may have been
    // "unknown" at span creation time if model_select fired after the span
    // was opened.
    if (sessionSpan) {
      if (modelId !== "unknown") {
        sessionSpan.setAttribute("gen_ai.request.model", modelId);
        sessionSpan.setAttribute("gen_ai.response.model", modelId);
        sessionSpan.setAttribute("pi.model.provider", providerId);
      }
      if (config.recordOutputs && lastAssistantResponse) {
        sessionSpan.setAttribute(
          "gen_ai.response.text",
          serializeAttribute(lastAssistantResponse, config.maxAttributeLength),
        );
      }
      // Aggregate token usage across all LLM requests in this agent invocation
      if (aggregateInputTokens > 0) {
        sessionSpan.setAttribute("gen_ai.usage.input_tokens", aggregateInputTokens);
      }
      if (aggregateOutputTokens > 0) {
        sessionSpan.setAttribute("gen_ai.usage.output_tokens", aggregateOutputTokens);
      }
      const aggregateTotal = aggregateInputTokens + aggregateOutputTokens;
      if (aggregateTotal > 0) {
        sessionSpan.setAttribute("gen_ai.usage.total_tokens", aggregateTotal);
      }
    }

    const session = Sentry.getIsolationScope().getSession();
    if (session && session.status === "ok") {
      Sentry.endSession();
    }

    if (sessionSpan) {
      setSpanStatus(sessionSpan, false);
      sessionSpan.end();
    }
    sessionSpan = undefined;
    completedMessages.clear();
    aggregateInputTokens = 0;
    aggregateOutputTokens = 0;
  }

  // --- session_start: capture session ID and set conversation ---
  pi.on("session_start", (_event, ctx) => {
    try {
      sessionId = ctx.sessionManager.getSessionId();
      setConversationId(sessionId);
      Sentry.startSession();
      uiContext = ctx.ui;
      ctx.ui.setStatus("sentry", "▲ Sentry (started)");
      setTimeout(() => {
        // Only revert if no flash overwrote it in the meantime
        if (!statusFlashTimer) {
          ctx.ui.setStatus("sentry", "▲ Sentry");
        }
      }, 5000);

      if (config.enableCLIInsights) {
        cli.run("auth status", { timeout: 10_000 }).then((result) => {
          sentryAuthenticated = result.code === 0;
          const authStatus = sentryAuthenticated ? "authenticated" : "not authenticated";
          uiContext?.setStatus("sentry", `▲ Sentry (${authStatus})`);
        }).catch(() => {
          // CLI not available — silently skip
        });
      }
    } catch (error) {
      Sentry.captureException(error);
      logger.warn("Failed to create session span", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // --- session_switch: reset conversation ID on session change ---
  pi.on("session_switch", (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    turnIndex = 0;
    previousTraceId = undefined;
    setConversationId(sessionId);
  });

  // --- session_shutdown: final cleanup ---
  pi.on("session_shutdown", async () => {
    try {
      cleanupSession();
      if (client) {
        await client.close(5000);
      }
    } catch (error) {
      Sentry.captureException(error);
      logger.warn("Failed to cleanup session on shutdown", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Safety net: flush on process exit in case session_shutdown never fires
  // (e.g. print mode, SIGKILL, unhandled crash).
  process.on("beforeExit", () => {
    cleanupSession();
  });

  // --- model_select: track current model ---
  pi.on("model_select", (event) => {
    try {
      modelId = event.model.id;
      providerId = event.model.provider;

      if (sessionSpan) {
        sessionSpan.setAttribute("gen_ai.request.model", modelId);
        sessionSpan.setAttribute("pi.model.provider", providerId);
      }
    } catch (error) {
      Sentry.captureException(error);
      logger.warn("Failed to capture model_select metadata", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // --- tool_execution_start: start gen_ai.execute_tool span ---
  pi.on("tool_execution_start", (event) => {
    turnHadToolCalls = true;
    try {
      const parentSpan = ensureSessionSpan();

      const span = Sentry.startInactiveSpan({
        parentSpan,
        op: "gen_ai.execute_tool",
        name: `execute_tool ${event.toolName}`,
        attributes: {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.agent.name": agentName,
          "gen_ai.request.model": modelId,
          "gen_ai.tool.name": event.toolName,
          "gen_ai.tool.type": "function",
          "pi.model.provider": providerId,
          "pi.tool_call.id": event.toolCallId,
          "pi.project.name": projectName,
          ...config.tags,
        },
      });

      if (config.recordInputs) {
        span.setAttribute(
          "gen_ai.tool.input",
          serializeAttribute(event.args, config.maxAttributeLength),
        );
      }

      toolSpans.set(event.toolCallId, span);
    } catch (error) {
      Sentry.captureException(error);
      logger.warn("Failed to start tool span", {
        error: error instanceof Error ? error.message : String(error),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
    }
  });

  // --- tool_execution_end: end tool span, capture errors ---
  pi.on("tool_execution_end", (event) => {
    try {
      const span = toolSpans.get(event.toolCallId);
      if (!span) {
        return;
      }

      if (config.recordOutputs) {
        span.setAttribute(
          "gen_ai.tool.output",
          serializeAttribute(event.result, config.maxAttributeLength),
        );
      }

      setSpanStatus(span, event.isError);

      span.end();
      toolSpans.delete(event.toolCallId);
      pendingSpanCount++;

      if (config.enableMetrics) {
        Sentry.metrics.count("gen_ai.client.tool.execution", 1, {
          attributes: {
            "gen_ai.agent.name": agentName,
            "gen_ai.tool.name": event.toolName,
            "pi.project.name": projectName,
            status: event.isError ? "error" : "ok",
            ...config.tags,
          },
        });
      }
    } catch (error) {
      Sentry.captureException(error);
      logger.warn("Failed to finish tool span", {
        error: error instanceof Error ? error.message : String(error),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
    }
  });

  // --- input: capture user prompt for gen_ai.request.messages ---
  // Also ends the previous interaction's span if it was kept alive across
  // tool-use turns, so the new interaction starts a fresh trace.
  pi.on("input", (event) => {
    if (typeof event.text === "string") {
      lastUserPrompt = event.text;
    }
    // End the previous interaction's span if still open
    if (sessionSpan) {
      previousTraceId = sessionSpan.spanContext().traceId;
      cleanupSession();
    }
    lastAssistantResponse = undefined;
    turnHadToolCalls = false;
    aggregateInputTokens = 0;
    aggregateOutputTokens = 0;
  });

  // --- message_start: open gen_ai.request span so we capture real LLM latency ---
  pi.on("message_start", (event) => {
    try {
      if (!config.includeMessageUsageSpans) {
        return;
      }

      const msg = event.message as unknown as Record<string, unknown>;
      if (msg.role !== "assistant") {
        return;
      }

      const timestamp = msg.timestamp as number;
      if (requestSpans.has(timestamp)) {
        return;
      }

      const parentSpan = ensureSessionSpan();
      const spanModel = (typeof msg.model === "string" && msg.model.length > 0) ? msg.model : modelId;

      const requestSpan = Sentry.startInactiveSpan({
        parentSpan,
        op: "gen_ai.request",
        name: `request ${spanModel}`,
        attributes: {
          "gen_ai.operation.name": "request",
          "gen_ai.request.model": spanModel,
          "gen_ai.response.model": spanModel,
          "gen_ai.agent.name": agentName,
          "pi.model.provider": providerId,
          "pi.project.name": projectName,
          ...config.tags,
        },
      });

      // Record the user prompt that triggered this request.  We intentionally
      // keep lastUserPrompt alive so that *all* LLM request spans within the
      // same turn (initial response → tool calls → follow-up) carry the user
      // prompt that started the turn.  It is naturally replaced when the next
      // `input` event fires.
      if (config.recordInputs && lastUserPrompt) {
        const inputMessages = JSON.stringify([{ role: "user", content: lastUserPrompt }]);
        requestSpan.setAttribute(
          "gen_ai.request.messages",
          serializeAttribute(inputMessages, config.maxAttributeLength),
        );
      }

      requestSpans.set(timestamp, requestSpan);
    } catch (error) {
      Sentry.captureException(error);
      logger.warn("Failed to start request span", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // --- message_end: close gen_ai.request span and attach token usage ---
  pi.on("message_end", (event) => {
    try {
      if (!config.includeMessageUsageSpans) {
        return;
      }

      const msg = event.message;
      if (!isAssistantMessage(msg)) {
        return;
      }

      // Use timestamp as dedup key since pi doesn't expose message IDs
      if (completedMessages.has(msg.timestamp)) {
        return;
      }
      completedMessages.add(msg.timestamp);

      // Update model info from the message itself
      modelId = msg.model;
      providerId = msg.provider;

      // Find the span opened at message_start; fall back to a new one if missing
      let usageSpan = requestSpans.get(msg.timestamp);
      if (usageSpan) {
        requestSpans.delete(msg.timestamp);
        // Update model name now that we have the confirmed value
        usageSpan.setAttribute("gen_ai.request.model", msg.model);
        usageSpan.setAttribute("gen_ai.response.model", msg.model);
        usageSpan.setAttribute("pi.model.provider", msg.provider);
        usageSpan.updateName(`request ${msg.model}`);
      } else {
        const parentSpan = ensureSessionSpan();
        usageSpan = Sentry.startInactiveSpan({
          parentSpan,
          op: "gen_ai.request",
          name: `request ${msg.model}`,
          attributes: {
            "gen_ai.operation.name": "request",
            "gen_ai.request.model": msg.model,
            "gen_ai.response.model": msg.model,
            "gen_ai.agent.name": agentName,
            "pi.model.provider": msg.provider,
            "pi.project.name": projectName,
            ...config.tags,
          },
        });
      }

      const { totalInput, totalOutput } = attachTokenUsage(usageSpan, msg.usage);
      aggregateInputTokens += totalInput;
      aggregateOutputTokens += totalOutput;

      // Record user prompt (in case message_start didn't fire or prompt came after).
      if (config.recordInputs && lastUserPrompt) {
        const inputMessages = JSON.stringify([{ role: "user", content: lastUserPrompt }]);
        usageSpan.setAttribute(
          "gen_ai.request.messages",
          serializeAttribute(inputMessages, config.maxAttributeLength),
        );
      }

      // Record assistant output and tool calls on the request span
      if (msg.content) {
        // Extract tool calls from the response
        const toolCalls = msg.content
          .filter((c): c is { type: "toolCall"; id: string; name: string; arguments: Record<string, any> } =>
            (c as any).type === "toolCall")
          .map((c) => ({ name: c.name, type: "function", arguments: JSON.stringify(c.arguments) }));
        if (toolCalls.length > 0) {
          usageSpan.setAttribute(
            "gen_ai.response.tool_calls",
            serializeAttribute(JSON.stringify(toolCalls), config.maxAttributeLength),
          );
        }

        // Record text output
        if (config.recordOutputs) {
          const textContent = msg.content
            .filter((c): c is { type: "text"; text: string } => (c as any).type === "text" && typeof (c as any).text === "string")
            .map((c) => c.text)
            .join("\n");
          if (textContent.length > 0) {
            lastAssistantResponse = textContent;
            usageSpan.setAttribute(
              "gen_ai.response.text",
              serializeAttribute(textContent, config.maxAttributeLength),
            );
          }
        }
      }
      setSpanStatus(usageSpan, false);
      usageSpan.end();
      pendingSpanCount++;

      if (config.enableMetrics) {
        const metricAttrs = {
          "gen_ai.agent.name": agentName,
          "pi.project.name": projectName,
          "gen_ai.request.model": msg.model,
          "pi.model.provider": msg.provider,
          ...config.tags,
        };

        if (msg.usage.input > 0) {
          Sentry.metrics.distribution("gen_ai.client.token.usage", msg.usage.input, {
            attributes: { ...metricAttrs, "gen_ai.token.type": "input" },
            unit: "token",
          });
        }
        if (msg.usage.output > 0) {
          Sentry.metrics.distribution("gen_ai.client.token.usage", msg.usage.output, {
            attributes: { ...metricAttrs, "gen_ai.token.type": "output" },
            unit: "token",
          });
        }
        if (msg.usage.cacheRead > 0) {
          Sentry.metrics.distribution("gen_ai.client.token.usage", msg.usage.cacheRead, {
            attributes: { ...metricAttrs, "gen_ai.token.type": "cached_input" },
            unit: "token",
          });
        }
      }
    } catch (error) {
      Sentry.captureException(error);
      logger.warn("Failed to create message usage span", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // --- turn_start: track turn index ---
  pi.on("turn_start", (event) => {
    turnIndex = event.turnIndex;
  });

  // --- turn_end: conditionally end the root span and flush ---
  // The Sentry SpanExporter only sends child spans when their root span ends.
  //
  // If this turn had tool calls, the LLM will respond again in a new turn
  // (tool results → follow-up response).  Keep the session span alive so the
  // entire interaction (LLM → tools → LLM → … → final text) stays in one
  // trace.  Only end and flush when the turn had NO tool calls — that means
  // the LLM produced a final text response and is waiting for user input.
  //
  // The `input` handler also ends the span as a safety net, ensuring no
  // span leaks across user interactions.
  pi.on("turn_end", async () => {
    if (turnHadToolCalls) {
      // More turns coming — keep the span alive for the follow-up LLM response
      turnHadToolCalls = false;
      return;
    }

    try {
      // Final text response turn — end the span and flush
      if (sessionSpan) {
        previousTraceId = sessionSpan.spanContext().traceId;
      }

      cleanupSession();
      pendingSpanCount++; // session span
      const flushedCount = pendingSpanCount;
      pendingSpanCount = 0;
      if (client) {
        await client.flush(5000);
      }
      flashStatus(flushedCount);

      if (config.enableCLIInsights && sentryAuthenticated) {
        const now = Date.now();
        if (now - lastBackgroundQuery >= BACKGROUND_QUERY_INTERVAL) {
          lastBackgroundQuery = now;
          runBackgroundQuery().catch((err) => {
            logger.warn("Background Sentry query failed", { error: String(err) });
          });
        }
      }
    } catch (error) {
      Sentry.captureException(error);
      logger.warn("Failed to flush on turn_end", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    turnHadToolCalls = false;
  });

  // --- agent_end: breadcrumb only (flush already happened in turn_end) ---
  pi.on("agent_end", async () => {
    try {
      if (config.includeSessionEvents) {
        Sentry.addBreadcrumb({
          category: "pi.agent",
          level: "info",
          message: "agent_end",
        });
      }
    } catch (error) {
      Sentry.captureException(error);
      logger.warn("Failed to add agent_end breadcrumb", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
