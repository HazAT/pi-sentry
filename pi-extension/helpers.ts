import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { PluginLogger, ResolvedPluginConfig } from "./config.js";
import { basename, dirname } from "node:path";

/** Sentry span type — avoids importing Sentry in pure helper code */
export type SentrySpan = {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number }): void;
  spanContext(): { traceId: string };
  end(): void;
};

export function createLogger(): PluginLogger {
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

export function getProjectName(config: ResolvedPluginConfig, cwd: string): string {
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
export function detectSubagentName(): string | undefined {
  const args = process.argv;
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== "--append-system-prompt") continue;
    const promptPath = args[i + 1];
    if (!promptPath) continue;

    const dirName = basename(dirname(promptPath));
    if (!dirName.startsWith("pi-subagent-")) continue;

    const fileName = basename(promptPath);
    const agentName = fileName.endsWith(".md") ? fileName.slice(0, -3) : fileName;

    if (/^[\w.-]+$/.test(agentName) && agentName.length > 0) {
      return agentName;
    }
  }
  return undefined;
}

export function getAgentName(config: ResolvedPluginConfig): string {
  if (config.agentName && config.agentName.length > 0) {
    return config.agentName;
  }
  const subagentName = detectSubagentName();
  if (subagentName) {
    return `pi/${subagentName}`;
  }
  return "pi";
}

export function setSpanStatus(span: SentrySpan, isError: boolean): void {
  span.setStatus({ code: isError ? 2 : 1 });
}

export function isAuthError(output: string): boolean {
  const lower = output.toLowerCase();
  return [
    "not logged in",
    "not authenticated",
    "401",
    "auth token",
    "unauthorized",
    "login required",
    "run 'sentry auth login'",
    "run `sentry auth login`",
  ].some((indicator) => lower.includes(indicator));
}

export function attachTokenUsage(
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
  const totalTokens = totalInput + totalOutput;
  if (totalTokens > 0) {
    span.setAttribute("gen_ai.usage.total_tokens", totalTokens);
  }
  return { totalInput, totalOutput };
}

export function isAssistantMessage(msg: unknown): msg is AssistantMessage {
  if (!msg || typeof msg !== "object") {
    return false;
  }
  const m = msg as Record<string, unknown>;
  return (
    m.role === "assistant" &&
    typeof m.model === "string" &&
    m.usage !== null &&
    typeof m.usage === "object"
  );
}

export function formatSentryDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
