import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import * as Sentry from "@sentry/node";
import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import { loadPluginConfig, type PluginLogger, type ResolvedPluginConfig } from "./config.js";
import { serializeAttribute } from "./serialize.js";

type SentrySpan = ReturnType<typeof Sentry.startInactiveSpan>;

let sentryInitialized = false;
let initializedDsn: string | null = null;

function createLogger(): PluginLogger {
  const service = "pi-sentry-monitor";

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

function getAgentName(config: ResolvedPluginConfig, projectName: string): string {
  if (config.agentName && config.agentName.length > 0) {
    return config.agentName;
  }

  const subagentName = detectSubagentName();
  if (subagentName) {
    return `${projectName}/${subagentName}`;
  }

  return projectName;
}

function setSpanStatus(span: SentrySpan, isError: boolean): void {
  span.setStatus({ code: isError ? 2 : 1 });
}

function initSentry(config: ResolvedPluginConfig, logger: PluginLogger): void {
  if (!sentryInitialized) {
    Sentry.init({
      dsn: config.dsn,
      tracesSampleRate: config.tracesSampleRate,
      environment: config.environment,
      release: config.release,
      debug: config.debug,
      sendDefaultPii: false,
    });

    sentryInitialized = true;
    initializedDsn = config.dsn;
    return;
  }

  if (initializedDsn && initializedDsn !== config.dsn) {
    logger.warn("Sentry is already initialized with a different DSN. Keeping the original client.", {
      initializedDsn,
      requestedDsn: config.dsn,
    });
  }
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
): void {
  if (typeof usage.input === "number") {
    span.setAttribute("gen_ai.usage.input_tokens", usage.input);
  }
  if (typeof usage.output === "number") {
    span.setAttribute("gen_ai.usage.output_tokens", usage.output);
  }
  if (typeof usage.cacheRead === "number") {
    span.setAttribute("gen_ai.usage.input_tokens.cached", usage.cacheRead);
  }
  if (typeof usage.cacheWrite === "number") {
    span.setAttribute("gen_ai.usage.input_tokens.cache_write", usage.cacheWrite);
  }
  if (typeof usage.totalTokens === "number") {
    span.setAttribute("gen_ai.usage.total_tokens", usage.totalTokens);
  }
}

function isAssistantMessage(msg: unknown): msg is AssistantMessage {
  if (!msg || typeof msg !== "object") {
    return false;
  }
  const m = msg as Record<string, unknown>;
  return m.role === "assistant" && typeof m.model === "string" && m.usage !== null && typeof m.usage === "object";
}

export default async function piSentryMonitor(pi: ExtensionAPI) {
  const logger = createLogger();

  // Get cwd from first session_start event context, but load config eagerly with process.cwd()
  const cwd = process.cwd();
  const loaded = await loadPluginConfig(cwd, logger);

  if (!loaded) {
    return;
  }

  const config = loaded.config;
  const projectName = getProjectName(config, cwd);
  const agentName = getAgentName(config, projectName);

  initSentry(config, logger);

  logger.info("Sentry observability extension enabled", {
    source: loaded.source,
    projectName,
    agentName,
    tracesSampleRate: config.tracesSampleRate,
    recordInputs: config.recordInputs,
    recordOutputs: config.recordOutputs,
  });


  // Single-session state (pi runs one session at a time)
  let sessionSpan: SentrySpan | undefined;
  let modelId = "unknown";
  let providerId: string = "unknown";
  const toolSpans = new Map<string, SentrySpan>();
  const requestSpans = new Map<number, SentrySpan>(); // keyed by message timestamp
  const completedMessages = new Set<number>(); // track by timestamp to avoid dupe usage spans
  let lastUserPrompt: string | undefined;

  // Conversation tracking — links turns within the same session
  let sessionId: string | undefined;     // from pi's session manager, set on session_start
  let conversationId = randomUUID();     // stable ID across turns; reset on session switch
  let turnIndex = 0;                     // incremented on turn_start
  let previousTraceId: string | undefined; // trace ID of the previous turn for linking

  function ensureSessionSpan(): SentrySpan {
    if (sessionSpan) {
      return sessionSpan;
    }

    sessionSpan = Sentry.startInactiveSpan({
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
        "gen_ai.conversation.id": conversationId,
        "pi.turn.index": turnIndex,
        ...(sessionId ? { "pi.session.id": sessionId } : {}),
        ...(lastUserPrompt && config.recordInputs ? {
          "gen_ai.prompt": serializeAttribute(lastUserPrompt, config.maxAttributeLength),
        } : {}),
        ...config.tags,
      },
    });

    return sessionSpan;
  }

  function cleanupSession(): void {
    for (const [key, span] of toolSpans) {
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
        span.setAttribute("pi.model.provider", providerId);
      }
      span.end();
      requestSpans.delete(key);
    }

    sessionSpan?.end();
    sessionSpan = undefined;
    completedMessages.clear();
  }

  // --- session_start: capture session ID ---
  pi.on("session_start", (_event, ctx) => {
    try {
      sessionId = ctx.sessionManager.getSessionId();
      ensureSessionSpan();
    } catch (error) {
      logger.warn("Failed to create session span", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // --- session_switch: reset conversation ID on session change ---
  pi.on("session_switch", () => {
    conversationId = randomUUID();
    turnIndex = 0;
    previousTraceId = undefined;
  });

  // --- session_shutdown: final cleanup ---
  pi.on("session_shutdown", async () => {
    try {
      cleanupSession();
      await Sentry.close(5000);
    } catch (error) {
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
      logger.warn("Failed to capture model_select metadata", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // --- tool_execution_start: start gen_ai.execute_tool span ---
  pi.on("tool_execution_start", (event) => {
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

      if (event.isError) {
        Sentry.captureMessage(`Tool execution error: ${event.toolName}`, {
          level: "error",
          tags: {
            "pi.tool_call.id": event.toolCallId,
            "pi.tool": event.toolName,
            ...config.tags,
          },
          extra: {
            result: event.result,
          },
        });
      }

      span.end();
      toolSpans.delete(event.toolCallId);

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
      logger.warn("Failed to finish tool span", {
        error: error instanceof Error ? error.message : String(error),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
    }
  });

  // --- input: capture user prompt for gen_ai.input.messages ---
  pi.on("input", (event) => {
    if (typeof event.text === "string") {
      lastUserPrompt = event.text;
    }
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
          "gen_ai.input.messages",
          serializeAttribute(inputMessages, config.maxAttributeLength),
        );
      }

      requestSpans.set(timestamp, requestSpan);
    } catch (error) {
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
            "gen_ai.agent.name": agentName,
            "pi.model.provider": msg.provider,
            "pi.project.name": projectName,
            ...config.tags,
          },
        });
      }

      attachTokenUsage(usageSpan, msg.usage);

      // Record user prompt (in case message_start didn't fire or prompt came after).
      if (config.recordInputs && lastUserPrompt) {
        const inputMessages = JSON.stringify([{ role: "user", content: lastUserPrompt }]);
        usageSpan.setAttribute(
          "gen_ai.input.messages",
          serializeAttribute(inputMessages, config.maxAttributeLength),
        );
      }

      // Record assistant output on the request span
      if (config.recordOutputs && msg.content) {
        const textContent = msg.content
          .filter((c): c is { type: "text"; text: string } => (c as any).type === "text" && typeof (c as any).text === "string")
          .map((c) => c.text)
          .join("\n");
        if (textContent.length > 0) {
          usageSpan.setAttribute(
            "gen_ai.response.text",
            serializeAttribute(textContent, config.maxAttributeLength),
          );
        }
      }
      usageSpan.end();

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
      logger.warn("Failed to create message usage span", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // --- turn_start: track turn index ---
  pi.on("turn_start", (event) => {
    turnIndex = event.turnIndex;
  });

  // --- turn_end: end the root span and flush per-turn ---
  // The Sentry SpanExporter only sends child spans when their root span ends.
  // We end the root invoke_agent span at the end of every turn so each turn
  // becomes a self-contained trace with all its tool calls and LLM requests.
  //
  // This MUST happen in turn_end (not agent_end) because turn_end fires
  // DURING the agent loop while agent.prompt() is still running.  agent_end
  // fires after agent.prompt() resolves, and print mode's session.prompt()
  // does not await the extension event queue — the process can exit before
  // the agent_end handler completes.
  pi.on("turn_end", async () => {
    try {
      // Capture trace ID before ending, so the next turn can link back
      if (sessionSpan) {
        previousTraceId = sessionSpan.spanContext().traceId;
      }

      cleanupSession();
      await Sentry.flush(5000);
    } catch (error) {
      logger.warn("Failed to flush on turn_end", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
      logger.warn("Failed to add agent_end breadcrumb", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
