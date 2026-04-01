import { describe, it, expect } from "vitest";
import { serializeAttribute } from "../serialize.ts";

describe("serializeAttribute", () => {
  it("passes through plain strings", () => {
    expect(serializeAttribute("hello world", 1000)).toBe("hello world");
  });

  it("truncates long strings", () => {
    const long = "a".repeat(200);
    const result = serializeAttribute(long, 100);
    expect(result).toHaveLength(100 + "...[truncated 100 chars]".length);
    expect(result).toContain("...[truncated 100 chars]");
  });

  it("redacts sensitive keys", () => {
    const input = { api_key: "secret123", name: "test" };
    const result = serializeAttribute(input, 10000);
    const parsed = JSON.parse(result);
    expect(parsed.api_key).toBe("[REDACTED]");
    expect(parsed.name).toBe("test");
  });

  it("redacts various sensitive key patterns", () => {
    const input = {
      token: "t1",
      secret: "s1",
      password: "p1",
      authorization: "a1",
      cookie: "c1",
      session: "sess1",
      bearer: "b1",
      "x-api-key": "x1",
    };
    const result = JSON.parse(serializeAttribute(input, 10000));
    for (const key of Object.keys(input)) {
      expect(result[key]).toBe("[REDACTED]");
    }
  });

  it("redacts nested objects", () => {
    const input = { outer: { api_key: "nested-secret", safe: "visible" } };
    const result = JSON.parse(serializeAttribute(input, 10000));
    expect(result.outer.api_key).toBe("[REDACTED]");
    expect(result.outer.safe).toBe("visible");
  });

  it("redacts sensitive fields inside JSON strings", () => {
    const input = JSON.stringify({
      name: "test",
      nested: { bearer: "secret-token", safe: "visible" },
    });
    const result = JSON.parse(serializeAttribute(input, 10000));
    expect(result.name).toBe("test");
    expect(result.nested.bearer).toBe("[REDACTED]");
    expect(result.nested.safe).toBe("visible");
  });

  it("leaves non-JSON strings untouched", () => {
    const input = "Authorization: Bearer secret-token";
    expect(serializeAttribute(input, 10000)).toBe(input);
  });

  it("handles circular references", () => {
    const obj: any = { name: "test" };
    obj.self = obj;
    const result = JSON.parse(serializeAttribute(obj, 10000));
    expect(result.name).toBe("test");
    expect(result.self).toBe("[Circular]");
  });

  it("respects depth limit", () => {
    // Build a deeply nested object (>8 levels)
    let obj: any = { value: "deep" };
    for (let i = 0; i < 10; i++) {
      obj = { nested: obj };
    }
    const result = serializeAttribute(obj, 100000);
    expect(result).toContain("[DepthLimit]");
  });

  it("passes through null and undefined", () => {
    expect(serializeAttribute(null, 1000)).toBe("null");
    // undefined is not JSON-serializable
    expect(serializeAttribute(undefined, 1000)).toBe("[Unserializable]");
  });

  it("serializes numbers and booleans", () => {
    expect(serializeAttribute(42, 1000)).toBe("42");
    expect(serializeAttribute(true, 1000)).toBe("true");
  });

  it("handles arrays", () => {
    const input = [{ token: "secret" }, { name: "safe" }];
    const result = JSON.parse(serializeAttribute(input, 10000));
    expect(result[0].token).toBe("[REDACTED]");
    expect(result[1].name).toBe("safe");
  });
});
