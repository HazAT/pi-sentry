import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { normalizeConfig, addEnvOverrides } from "../config.js";

const VALID_DSN = "https://key@sentry.io/123";

describe("normalizeConfig", () => {
  it("applies defaults for minimal config", () => {
    const result = normalizeConfig({ dsn: VALID_DSN });
    expect(result.dsn).toBe(VALID_DSN);
    expect(result.tracesSampleRate).toBe(1);
    expect(result.recordInputs).toBe(false);
    expect(result.recordOutputs).toBe(false);
    expect(result.maxAttributeLength).toBe(12000);
    expect(result.includeMessageUsageSpans).toBe(true);
    expect(result.includeSessionEvents).toBe(true);
    expect(result.enableMetrics).toBe(false);
    expect(result.enableCLIInsights).toBe(false);
    expect(result.tags).toEqual({});
  });

  it("throws on missing dsn", () => {
    expect(() => normalizeConfig({})).toThrow('"dsn"');
  });

  it("throws on empty dsn", () => {
    expect(() => normalizeConfig({ dsn: "" })).toThrow('"dsn"');
  });

  it("throws on invalid dsn URL", () => {
    expect(() => normalizeConfig({ dsn: "not-a-url" })).toThrow("valid URL");
  });

  it("throws on non-http protocol", () => {
    expect(() => normalizeConfig({ dsn: "ftp://key@sentry.io/123" })).toThrow("protocol");
  });

  it("throws on tracesSampleRate > 1", () => {
    expect(() => normalizeConfig({ dsn: VALID_DSN, tracesSampleRate: 1.5 })).toThrow(
      "between 0 and 1",
    );
  });

  it("throws on tracesSampleRate < 0", () => {
    expect(() => normalizeConfig({ dsn: VALID_DSN, tracesSampleRate: -0.1 })).toThrow(
      "between 0 and 1",
    );
  });

  it("throws on maxAttributeLength < 128", () => {
    expect(() => normalizeConfig({ dsn: VALID_DSN, maxAttributeLength: 50 })).toThrow(">= 128");
  });

  it("accepts valid overrides", () => {
    const result = normalizeConfig({
      dsn: VALID_DSN,
      tracesSampleRate: 0.5,
      recordInputs: false,
      environment: "production",
      tags: { team: "infra" },
    });
    expect(result.tracesSampleRate).toBe(0.5);
    expect(result.recordInputs).toBe(false);
    expect(result.environment).toBe("production");
    expect(result.tags).toEqual({ team: "infra" });
  });
});

describe("addEnvOverrides", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "PI_SENTRY_DSN",
    "SENTRY_DSN",
    "PI_SENTRY_RECORD_INPUTS",
    "PI_SENTRY_RECORD_OUTPUTS",
    "PI_SENTRY_TAGS",
    "SENTRY_ENVIRONMENT",
    "PI_SENTRY_TRACES_SAMPLE_RATE",
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it("overrides dsn from PI_SENTRY_DSN", () => {
    process.env.PI_SENTRY_DSN = "https://env@sentry.io/456";
    const result = addEnvOverrides({});
    expect(result.dsn).toBe("https://env@sentry.io/456");
  });

  it("falls back to SENTRY_DSN", () => {
    process.env.SENTRY_DSN = "https://fallback@sentry.io/789";
    const result = addEnvOverrides({});
    expect(result.dsn).toBe("https://fallback@sentry.io/789");
  });

  it("overrides boolean from env", () => {
    process.env.PI_SENTRY_RECORD_INPUTS = "false";
    const result = addEnvOverrides({ recordInputs: true });
    expect(result.recordInputs).toBe(false);
  });

  it("overrides output capture boolean from env", () => {
    process.env.PI_SENTRY_RECORD_OUTPUTS = "true";
    const result = addEnvOverrides({ recordOutputs: false });
    expect(result.recordOutputs).toBe(true);
  });

  it("parses boolean env truthy values", () => {
    for (const val of ["1", "true", "yes", "on"]) {
      process.env.PI_SENTRY_RECORD_INPUTS = val;
      expect(addEnvOverrides({}).recordInputs).toBe(true);
    }
  });

  it("parses boolean env falsy values", () => {
    for (const val of ["0", "false", "no", "off"]) {
      process.env.PI_SENTRY_RECORD_INPUTS = val;
      expect(addEnvOverrides({}).recordInputs).toBe(false);
    }
  });

  it("overrides tags from env", () => {
    process.env.PI_SENTRY_TAGS = "team:infra,env:prod";
    const result = addEnvOverrides({ tags: { existing: "tag" } });
    expect(result.tags).toEqual({ existing: "tag", team: "infra", env: "prod" });
  });

  it("overrides environment from SENTRY_ENVIRONMENT", () => {
    process.env.SENTRY_ENVIRONMENT = "staging";
    const result = addEnvOverrides({});
    expect(result.environment).toBe("staging");
  });

  it("overrides tracesSampleRate from env", () => {
    process.env.PI_SENTRY_TRACES_SAMPLE_RATE = "0.25";
    const result = addEnvOverrides({});
    expect(result.tracesSampleRate).toBe(0.25);
  });
});
