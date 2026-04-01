import * as Sentry from "@sentry/node-core/light";
import { setConversationId } from "@sentry/core";
import type { ResolvedPluginConfig } from "./config.js";
import { serializeAttribute } from "./serialize.js";
import { setSpanStatus, attachTokenUsage, isAssistantMessage } from "./helpers.js";

type SentrySpan = ReturnType<typeof Sentry.startInactiveSpan>;

export class SessionTracer {
  private sessionSpan: SentrySpan | undefined;
  private modelId = "unknown";
  private providerId = "unknown";
  private readonly toolSpans = new Map<string, SentrySpan>();
  private readonly requestSpans = new Map<number, SentrySpan>();
  private readonly completedMessages = new Set<number>();
  private lastUserPrompt: string | undefined;
  private lastAssistantResponse: string | undefined;
  private aggregateInputTokens = 0;
  private aggregateOutputTokens = 0;
  private sessionId: string | undefined;
  private sessionFilePath: string | undefined;
  private turnIndex = 0;
  private _previousTraceId: string | undefined;
  private turnHadToolCalls = false;

  pendingSpanCount = 0;

  constructor(
    private readonly config: ResolvedPluginConfig,
    private readonly agentName: string,
    private readonly projectName: string,
  ) {}

  setSession(sessionId: string, sessionFilePath: string | undefined): void {
    this.sessionId = sessionId;
    this.sessionFilePath = sessionFilePath;
    setConversationId(sessionId);
  }

  resetSession(): void {
    this.turnIndex = 0;
    this._previousTraceId = undefined;
  }

  private ensureSessionSpan(): SentrySpan {
    if (this.sessionSpan) {
      return this.sessionSpan;
    }

    this.sessionSpan = Sentry.startNewTrace(() => {
      if (this.sessionId) {
        setConversationId(this.sessionId);
      }

      return Sentry.startInactiveSpan({
        op: "gen_ai.invoke_agent",
        name: `invoke_agent ${this.agentName}`,
        forceTransaction: true,
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": this.agentName,
          "gen_ai.request.model": this.modelId,
          "pi.model.provider": this.providerId,
          "pi.project.name": this.projectName,
          "pi.capture.session_events": this.config.includeSessionEvents,
          "pi.turn.index": this.turnIndex,
          ...(this.sessionId ? { "pi.session.id": this.sessionId } : {}),
          ...(this.sessionFilePath ? { "pi.session.file": this.sessionFilePath } : {}),
          ...(this.lastUserPrompt && this.config.recordInputs
            ? {
                "gen_ai.request.messages": serializeAttribute(
                  JSON.stringify([{ role: "user", content: this.lastUserPrompt }]),
                  this.config.maxAttributeLength,
                ),
              }
            : {}),
          ...this.config.tags,
        },
      });
    });

    return this.sessionSpan;
  }

  cleanupSession(): void {
    for (const [key, span] of this.toolSpans) {
      setSpanStatus(span, false);
      span.end();
      this.toolSpans.delete(key);
    }

    for (const [key, span] of this.requestSpans) {
      if (this.modelId !== "unknown") {
        span.setAttribute("gen_ai.request.model", this.modelId);
        span.setAttribute("gen_ai.response.model", this.modelId);
        span.setAttribute("pi.model.provider", this.providerId);
      }
      setSpanStatus(span, false);
      span.end();
      this.requestSpans.delete(key);
    }

    if (this.sessionSpan) {
      if (this.modelId !== "unknown") {
        this.sessionSpan.setAttribute("gen_ai.request.model", this.modelId);
        this.sessionSpan.setAttribute("gen_ai.response.model", this.modelId);
        this.sessionSpan.setAttribute("pi.model.provider", this.providerId);
      }
      if (this.config.recordOutputs && this.lastAssistantResponse) {
        this.sessionSpan.setAttribute(
          "gen_ai.response.text",
          serializeAttribute(this.lastAssistantResponse, this.config.maxAttributeLength),
        );
      }
      if (this.aggregateInputTokens > 0) {
        this.sessionSpan.setAttribute("gen_ai.usage.input_tokens", this.aggregateInputTokens);
      }
      if (this.aggregateOutputTokens > 0) {
        this.sessionSpan.setAttribute("gen_ai.usage.output_tokens", this.aggregateOutputTokens);
      }
      const aggregateTotal = this.aggregateInputTokens + this.aggregateOutputTokens;
      if (aggregateTotal > 0) {
        this.sessionSpan.setAttribute("gen_ai.usage.total_tokens", aggregateTotal);
      }
    }

    const session = Sentry.getIsolationScope().getSession();
    if (session && session.status === "ok") {
      Sentry.endSession();
    }

    if (this.sessionSpan) {
      setSpanStatus(this.sessionSpan, false);
      this.sessionSpan.end();
    }
    this.sessionSpan = undefined;
    this.completedMessages.clear();
    this.aggregateInputTokens = 0;
    this.aggregateOutputTokens = 0;
  }

  onModelSelect(event: { model: { id: string; provider: string } }): void {
    this.modelId = event.model.id;
    this.providerId = event.model.provider;

    if (this.sessionSpan) {
      this.sessionSpan.setAttribute("gen_ai.request.model", this.modelId);
      this.sessionSpan.setAttribute("pi.model.provider", this.providerId);
    }
  }

  onToolStart(event: { toolCallId: string; toolName: string; args: string }): void {
    this.turnHadToolCalls = true;
    const parentSpan = this.ensureSessionSpan();

    const span = Sentry.startInactiveSpan({
      parentSpan,
      op: "gen_ai.execute_tool",
      name: `execute_tool ${event.toolName}`,
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.agent.name": this.agentName,
        "gen_ai.request.model": this.modelId,
        "gen_ai.tool.name": event.toolName,
        "gen_ai.tool.type": "function",
        "pi.model.provider": this.providerId,
        "pi.tool_call.id": event.toolCallId,
        "pi.project.name": this.projectName,
        ...this.config.tags,
      },
    });

    if (this.config.recordInputs) {
      span.setAttribute(
        "gen_ai.tool.input",
        serializeAttribute(event.args, this.config.maxAttributeLength),
      );
    }

    this.toolSpans.set(event.toolCallId, span);
  }

  onToolEnd(event: {
    toolCallId: string;
    toolName: string;
    result: string;
    isError: boolean;
  }): void {
    const span = this.toolSpans.get(event.toolCallId);
    if (!span) return;

    if (this.config.recordOutputs) {
      span.setAttribute(
        "gen_ai.tool.output",
        serializeAttribute(event.result, this.config.maxAttributeLength),
      );
    }

    setSpanStatus(span, event.isError);
    span.end();
    this.toolSpans.delete(event.toolCallId);
    this.pendingSpanCount++;

    if (this.config.enableMetrics) {
      Sentry.metrics.count("gen_ai.client.tool.execution", 1, {
        attributes: {
          "gen_ai.agent.name": this.agentName,
          "gen_ai.tool.name": event.toolName,
          "pi.project.name": this.projectName,
          status: event.isError ? "error" : "ok",
          ...this.config.tags,
        },
      });
    }
  }

  onInput(event: { text?: string }): void {
    if (typeof event.text === "string") {
      this.lastUserPrompt = event.text;
    }
    if (this.sessionSpan) {
      this._previousTraceId = this.sessionSpan.spanContext().traceId;
      this.cleanupSession();
    }
    this.lastAssistantResponse = undefined;
    this.turnHadToolCalls = false;
    this.aggregateInputTokens = 0;
    this.aggregateOutputTokens = 0;
  }

  onMessageStart(event: { message: unknown }): void {
    if (!this.config.includeMessageUsageSpans) return;

    const msg = event.message as Record<string, unknown>;
    if (msg.role !== "assistant") return;

    const timestamp = msg.timestamp as number;
    if (this.requestSpans.has(timestamp)) return;

    const parentSpan = this.ensureSessionSpan();
    const spanModel =
      typeof msg.model === "string" && msg.model.length > 0 ? msg.model : this.modelId;

    const requestSpan = Sentry.startInactiveSpan({
      parentSpan,
      op: "gen_ai.request",
      name: `request ${spanModel}`,
      attributes: {
        "gen_ai.operation.name": "request",
        "gen_ai.request.model": spanModel,
        "gen_ai.response.model": spanModel,
        "gen_ai.agent.name": this.agentName,
        "pi.model.provider": this.providerId,
        "pi.project.name": this.projectName,
        ...this.config.tags,
      },
    });

    if (this.config.recordInputs && this.lastUserPrompt) {
      const inputMessages = JSON.stringify([{ role: "user", content: this.lastUserPrompt }]);
      requestSpan.setAttribute(
        "gen_ai.request.messages",
        serializeAttribute(inputMessages, this.config.maxAttributeLength),
      );
    }

    this.requestSpans.set(timestamp, requestSpan);
  }

  onMessageEnd(event: { message: unknown }): void {
    if (!this.config.includeMessageUsageSpans) return;

    const msg = event.message;
    if (!isAssistantMessage(msg)) return;

    if (this.completedMessages.has(msg.timestamp)) return;
    this.completedMessages.add(msg.timestamp);

    this.modelId = msg.model;
    this.providerId = msg.provider;

    let usageSpan = this.requestSpans.get(msg.timestamp);
    if (usageSpan) {
      this.requestSpans.delete(msg.timestamp);
      usageSpan.setAttribute("gen_ai.request.model", msg.model);
      usageSpan.setAttribute("gen_ai.response.model", msg.model);
      usageSpan.setAttribute("pi.model.provider", msg.provider);
      usageSpan.updateName(`request ${msg.model}`);
    } else {
      const parentSpan = this.ensureSessionSpan();
      usageSpan = Sentry.startInactiveSpan({
        parentSpan,
        op: "gen_ai.request",
        name: `request ${msg.model}`,
        attributes: {
          "gen_ai.operation.name": "request",
          "gen_ai.request.model": msg.model,
          "gen_ai.response.model": msg.model,
          "gen_ai.agent.name": this.agentName,
          "pi.model.provider": msg.provider,
          "pi.project.name": this.projectName,
          ...this.config.tags,
        },
      });
    }

    const { totalInput, totalOutput } = attachTokenUsage(usageSpan, msg.usage);
    this.aggregateInputTokens += totalInput;
    this.aggregateOutputTokens += totalOutput;

    if (this.config.recordInputs && this.lastUserPrompt) {
      const inputMessages = JSON.stringify([{ role: "user", content: this.lastUserPrompt }]);
      usageSpan.setAttribute(
        "gen_ai.request.messages",
        serializeAttribute(inputMessages, this.config.maxAttributeLength),
      );
    }

    if (msg.content) {
      const toolCalls = msg.content
        .filter(
          (
            c: any,
          ): c is {
            type: "toolCall";
            id: string;
            name: string;
            arguments: Record<string, any>;
          } => (c as any).type === "toolCall",
        )
        .map((c: any) => ({
          name: c.name,
          type: "function",
          arguments: JSON.stringify(c.arguments),
        }));
      if (toolCalls.length > 0) {
        usageSpan.setAttribute(
          "gen_ai.response.tool_calls",
          serializeAttribute(JSON.stringify(toolCalls), this.config.maxAttributeLength),
        );
      }

      if (this.config.recordOutputs) {
        const textContent = msg.content
          .filter(
            (c: any): c is { type: "text"; text: string } =>
              (c as any).type === "text" && typeof (c as any).text === "string",
          )
          .map((c: any) => c.text)
          .join("\n");
        if (textContent.length > 0) {
          this.lastAssistantResponse = textContent;
          usageSpan.setAttribute(
            "gen_ai.response.text",
            serializeAttribute(textContent, this.config.maxAttributeLength),
          );
        }
      }
    }
    setSpanStatus(usageSpan, false);
    usageSpan.end();
    this.pendingSpanCount++;

    if (this.config.enableMetrics) {
      const metricAttrs = {
        "gen_ai.agent.name": this.agentName,
        "pi.project.name": this.projectName,
        "gen_ai.request.model": msg.model,
        "pi.model.provider": msg.provider,
        ...this.config.tags,
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
  }

  onTurnStart(event: { turnIndex: number }): void {
    this.turnIndex = event.turnIndex;
  }

  /** Returns true if the caller should flush (final text response, no more turns). */
  onTurnEnd(): boolean {
    if (this.turnHadToolCalls) {
      this.turnHadToolCalls = false;
      return false;
    }

    if (this.sessionSpan) {
      this._previousTraceId = this.sessionSpan.spanContext().traceId;
    }

    this.cleanupSession();
    this.pendingSpanCount++;
    this.turnHadToolCalls = false;
    return true;
  }
}
