import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  attachTokenUsage,
  detectSubagentName,
  isAuthError,
  isAssistantMessage,
  getProjectName,
  getAgentName,
  formatSentryDuration,
  setSpanStatus,
} from "../helpers.ts";
import type { ResolvedPluginConfig } from "../config.ts";

function mockSpan() {
  const attrs: Record<string, string | number | boolean> = {};
  let statusCode: number | undefined;
  return {
    setAttribute: (key: string, value: string | number | boolean) => {
      attrs[key] = value;
    },
    setStatus: (status: { code: number }) => {
      statusCode = status.code;
    },
    spanContext: () => ({ traceId: "mock-trace-id" }),
    end: () => {},
    get attrs() {
      return attrs;
    },
    get statusCode() {
      return statusCode;
    },
  };
}

function makeConfig(overrides: Partial<ResolvedPluginConfig> = {}): ResolvedPluginConfig {
  return {
    dsn: "https://key@sentry.io/123",
    tracesSampleRate: 1,
    recordInputs: true,
    recordOutputs: true,
    maxAttributeLength: 12000,
    includeMessageUsageSpans: true,
    includeSessionEvents: true,
    enableMetrics: false,
    enableCLIInsights: false,
    tags: {},
    ...overrides,
  };
}

describe("attachTokenUsage", () => {
  it("computes totalInput as input + cacheRead + cacheWrite", () => {
    const span = mockSpan();
    const result = attachTokenUsage(span, {
      input: 100,
      output: 50,
      cacheRead: 200,
      cacheWrite: 25,
      totalTokens: 375,
    });
    expect(result.totalInput).toBe(325); // 100 + 200 + 25
    expect(result.totalOutput).toBe(50);
    expect(span.attrs["gen_ai.usage.input_tokens"]).toBe(325);
    expect(span.attrs["gen_ai.usage.output_tokens"]).toBe(50);
    expect(span.attrs["gen_ai.usage.total_tokens"]).toBe(375);
    expect(span.attrs["gen_ai.usage.input_tokens.cached"]).toBe(200);
    expect(span.attrs["gen_ai.usage.input_tokens.cache_write"]).toBe(25);
  });

  it("does not set input_tokens when total is 0", () => {
    const span = mockSpan();
    attachTokenUsage(span, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    });
    expect(span.attrs["gen_ai.usage.input_tokens"]).toBeUndefined();
    expect(span.attrs["gen_ai.usage.output_tokens"]).toBeUndefined();
    expect(span.attrs["gen_ai.usage.total_tokens"]).toBeUndefined();
  });
});

describe("detectSubagentName", () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = process.argv;
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it("detects agent name from valid pi-subagent path", () => {
    process.argv = ["node", "pi", "--append-system-prompt", "/tmp/pi-subagent-abc123/worker.md"];
    expect(detectSubagentName()).toBe("worker");
  });

  it("returns undefined for non-matching directory", () => {
    process.argv = ["node", "pi", "--append-system-prompt", "/tmp/other-dir/worker.md"];
    expect(detectSubagentName()).toBeUndefined();
  });

  it("returns undefined when flag is missing", () => {
    process.argv = ["node", "pi"];
    expect(detectSubagentName()).toBeUndefined();
  });

  it("handles agent name without .md extension", () => {
    process.argv = ["node", "pi", "--append-system-prompt", "/tmp/pi-subagent-xyz/scout"];
    expect(detectSubagentName()).toBe("scout");
  });
});

describe("isAuthError", () => {
  it("detects common auth error patterns", () => {
    expect(isAuthError("Error: not logged in")).toBe(true);
    expect(isAuthError("401 Unauthorized")).toBe(true);
    expect(isAuthError("Please run 'sentry auth login'")).toBe(true);
    expect(isAuthError("Not authenticated")).toBe(true);
    expect(isAuthError("login required")).toBe(true);
  });

  it("returns false for normal output", () => {
    expect(isAuthError("Found 5 issues")).toBe(false);
    expect(isAuthError("Trace abc123 loaded")).toBe(false);
    expect(isAuthError("")).toBe(false);
  });
});

describe("isAssistantMessage", () => {
  it("returns true for valid assistant message", () => {
    expect(
      isAssistantMessage({
        role: "assistant",
        model: "claude-3",
        usage: { input: 100, output: 50 },
      }),
    ).toBe(true);
  });

  it("returns false for non-assistant role", () => {
    expect(
      isAssistantMessage({
        role: "user",
        model: "claude-3",
        usage: { input: 100 },
      }),
    ).toBe(false);
  });

  it("returns false for missing model", () => {
    expect(
      isAssistantMessage({
        role: "assistant",
        usage: { input: 100 },
      }),
    ).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isAssistantMessage(null)).toBe(false);
    expect(isAssistantMessage(undefined)).toBe(false);
  });

  it("returns false for null usage", () => {
    expect(
      isAssistantMessage({
        role: "assistant",
        model: "claude-3",
        usage: null,
      }),
    ).toBe(false);
  });
});

describe("getProjectName", () => {
  it("uses config.projectName when set", () => {
    expect(getProjectName(makeConfig({ projectName: "my-project" }), "/some/path")).toBe(
      "my-project",
    );
  });

  it("falls back to basename of cwd", () => {
    expect(getProjectName(makeConfig(), "/home/user/my-app")).toBe("my-app");
  });

  it("returns 'pi-project' for empty basename", () => {
    expect(getProjectName(makeConfig(), "/")).toBe("pi-project");
  });
});

describe("getAgentName", () => {
  it("uses config.agentName when set", () => {
    expect(getAgentName(makeConfig({ agentName: "custom-agent" }))).toBe("custom-agent");
  });

  it("defaults to 'pi' when no config or subagent", () => {
    // Reset argv to not match subagent pattern
    const saved = process.argv;
    process.argv = ["node", "pi"];
    expect(getAgentName(makeConfig())).toBe("pi");
    process.argv = saved;
  });
});

describe("formatSentryDuration", () => {
  it("formats milliseconds to seconds", () => {
    expect(formatSentryDuration(1500)).toBe("1.5s");
    expect(formatSentryDuration(500)).toBe("0.5s");
    expect(formatSentryDuration(0)).toBe("0.0s");
    expect(formatSentryDuration(10000)).toBe("10.0s");
  });
});

describe("setSpanStatus", () => {
  it("sets code 2 for errors", () => {
    const span = mockSpan();
    setSpanStatus(span, true);
    expect(span.statusCode).toBe(2);
  });

  it("sets code 1 for success", () => {
    const span = mockSpan();
    setSpanStatus(span, false);
    expect(span.statusCode).toBe(1);
  });
});
