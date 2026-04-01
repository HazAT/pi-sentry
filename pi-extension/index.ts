import type { ExtensionAPI, ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { createSentryCLI } from "./sentry-cli.js";
import * as Sentry from "@sentry/node-core/light";
import { initWithoutDefaultIntegrations, type LightNodeClient } from "@sentry/node-core/light";
import { conversationIdIntegration } from "@sentry/core";
import { loadPluginConfig, type ResolvedPluginConfig } from "./config.js";
import { createLogger, getProjectName, getAgentName } from "./helpers.js";
import { createSentryTool } from "./tool.js";
import { SessionTracer } from "./tracing.js";

let sentryInitialized = false;
let initializedDsn: string | null = null;

function initSentry(
  config: ResolvedPluginConfig,
  logger: ReturnType<typeof createLogger>,
): LightNodeClient | undefined {
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
      conversationIdIntegration(),
    ],
  });

  sentryInitialized = true;
  initializedDsn = config.dsn;
  return client;
}

export default async function piSentryMonitor(pi: ExtensionAPI) {
  const logger = createLogger();
  const cwd = process.cwd();

  // Register init block renderer for conversation display
  pi.registerMessageRenderer("sentry-init", (message, { expanded }, theme) => {
    const d = message.details as
      | {
          monitoring: boolean;
          project?: string;
          agent?: string;
          environment?: string;
          source?: string;
          tracing?: boolean;
          inputs?: boolean;
          outputs?: boolean;
        }
      | undefined;

    const lines: string[] = [];

    if (!d?.monitoring) {
      lines.push(
        theme.fg("warning", "▲ Sentry") + theme.fg("muted", " · tool only (no DSN configured)"),
      );
    } else {
      lines.push(theme.fg("success", "▲ Sentry") + theme.fg("muted", " · monitoring active"));
      if (expanded) {
        const dim = (label: string, value: string) =>
          `  ${theme.fg("muted", label + ":")} ${value}`;
        if (d.project) lines.push(dim("Project", d.project));
        if (d.agent) lines.push(dim("Agent", d.agent));
        if (d.environment) lines.push(dim("Environment", d.environment));
        if (d.source) lines.push(dim("Config", d.source));
        const flags: string[] = [];
        if (d.tracing) flags.push("tracing");
        if (d.inputs) flags.push("inputs");
        if (d.outputs) flags.push("outputs");
        if (flags.length > 0) lines.push(dim("Capture", flags.join(", ")));
      }
    }

    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(lines.join("\n"), 0, 0));
    return box;
  });

  // Register sentry CLI tool — always available regardless of DSN config
  const cli = createSentryCLI((cmd, args, opts) =>
    pi.exec(cmd, args, { timeout: opts?.timeout, cwd: opts?.cwd ?? cwd }),
  );
  pi.registerTool(createSentryTool(cli));

  // Load config — if no DSN, register tool-only mode and return
  const loaded = await loadPluginConfig(cwd, logger);

  if (!loaded) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.setStatus("sentry", "▲ Sentry (no DSN configured)");
      pi.sendMessage({
        customType: "sentry-init",
        content: "Sentry extension loaded (tool only, no monitoring)",
        display: true,
        details: { monitoring: false },
      });
    });
    return;
  }

  const config = loaded.config;
  const projectName = getProjectName(config, cwd);
  const agentName = getAgentName(config);
  const client = initSentry(config, logger);
  const tracer = new SessionTracer(config, agentName, projectName);

  // Capture extension errors from other extensions.
  // When any extension handler throws, pi's ExtensionRunner calls emitError()
  // which now also emits an "extension_error" event that extensions can listen to.
  pi.on("extension_error" as any, (event: any) => {
    const err = new Error(
      `Extension error in ${event.extensionPath} during ${event.event}: ${event.error}`,
    );
    if (event.stack) err.stack = event.stack;
    Sentry.captureException(err, {
      tags: {
        "pi.extension.path": event.extensionPath,
        "pi.extension.event": event.event,
      },
    });
  });

  // Background CLI insights state
  let sentryAuthenticated = false;
  let lastBackgroundQuery = 0;
  const BACKGROUND_QUERY_INTERVAL = 60_000;

  // Status bar flash state
  let uiContext: ExtensionUIContext | undefined;
  let statusFlashTimer: ReturnType<typeof setTimeout> | undefined;

  function flashStatus(count: number): void {
    if (!uiContext || count === 0) return;
    if (statusFlashTimer) clearTimeout(statusFlashTimer);
    uiContext.setStatus("sentry", `▲ Sentry (sent ${count} event${count === 1 ? "" : "s"})`);
    statusFlashTimer = setTimeout(() => {
      uiContext?.setStatus("sentry", "▲ Sentry");
      statusFlashTimer = undefined;
    }, 5000);
  }

  async function runBackgroundQuery() {
    uiContext?.setStatus("sentry", "▲ Sentry (checking issues...)");
    try {
      const result = await cli.run("issue list --limit 3 --json --fields shortId,title,level", {
        timeout: 15_000,
      });
      uiContext?.setStatus("sentry", "▲ Sentry (authenticated)");
      if (result.code === 0 && result.stdout.trim()) {
        pi.sendUserMessage(`[Sentry context] Recent issues:\n${result.stdout}`, {
          deliverAs: "steer",
        });
      }
    } catch {
      uiContext?.setStatus("sentry", "▲ Sentry (authenticated)");
    }
  }

  // --- Wire pi events to tracer ---

  pi.on("session_start", (_event, ctx) => {
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      tracer.setSession(sessionId, ctx.sessionManager.getSessionFile());
      Sentry.startSession();
      uiContext = ctx.ui;
      ctx.ui.setStatus("sentry", "▲ Sentry (started)");

      pi.sendMessage({
        customType: "sentry-init",
        content: `Sentry monitoring active. Your session ID is \`${sessionId}\`. When querying Sentry, filter by \`pi.session.id:${sessionId}\` to find traces from this session.`,
        display: true,
        details: {
          monitoring: true,
          project: projectName,
          agent: agentName,
          environment: config.environment,
          source: loaded.source,
          tracing: config.tracesSampleRate > 0,
          inputs: config.recordInputs,
          outputs: config.recordOutputs,
        },
      });

      setTimeout(() => {
        if (!statusFlashTimer) {
          ctx.ui.setStatus("sentry", "▲ Sentry");
        }
      }, 5000);

      if (config.enableCLIInsights) {
        cli
          .run("auth status", { timeout: 10_000 })
          .then((result) => {
            sentryAuthenticated = result.code === 0;
            const authStatus = sentryAuthenticated ? "authenticated" : "not authenticated";
            uiContext?.setStatus("sentry", `▲ Sentry (${authStatus})`);
          })
          .catch(() => {});
      }
    } catch (error) {
      Sentry.captureException(error);
      logger.warn("Failed to create session span", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  pi.on("session_switch", (_event, ctx) => {
    tracer.setSession(ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile());
    tracer.resetSession();
  });

  pi.on("session_shutdown", async () => {
    try {
      tracer.cleanupSession();
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

  process.on("beforeExit", () => {
    tracer.cleanupSession();
  });

  pi.on("model_select", (event) => {
    try {
      tracer.onModelSelect(event);
    } catch (error) {
      Sentry.captureException(error);
      logger.warn("Failed to capture model_select metadata", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  pi.on("tool_execution_start", (event) => {
    try {
      tracer.onToolStart(event);
    } catch (error) {
      Sentry.captureException(error);
      logger.warn("Failed to start tool span", {
        error: error instanceof Error ? error.message : String(error),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
    }
  });

  pi.on("tool_execution_end", (event) => {
    try {
      tracer.onToolEnd(event);
    } catch (error) {
      Sentry.captureException(error);
      logger.warn("Failed to finish tool span", {
        error: error instanceof Error ? error.message : String(error),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
    }
  });

  pi.on("input", (event) => {
    tracer.onInput(event);
  });

  pi.on("message_start", (event) => {
    try {
      tracer.onMessageStart(event);
    } catch (error) {
      Sentry.captureException(error);
      logger.warn("Failed to start request span", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  pi.on("message_end", (event) => {
    try {
      tracer.onMessageEnd(event);
    } catch (error) {
      Sentry.captureException(error);
      logger.warn("Failed to create message usage span", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  pi.on("turn_start", (event) => {
    tracer.onTurnStart(event);
  });

  pi.on("turn_end", async () => {
    try {
      const shouldFlush = tracer.onTurnEnd();
      if (!shouldFlush) return;

      const flushedCount = tracer.pendingSpanCount;
      tracer.pendingSpanCount = 0;
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
  });

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
