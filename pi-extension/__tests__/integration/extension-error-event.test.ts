import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createTestSession, type TestSessionContext } from "./helpers/setup.js";

describe("extension_error event", () => {
  let ctx: TestSessionContext;

  afterAll(async () => {
    await ctx?.cleanup();
  });

  it("captures errors from broken extension handlers via extension_error event", async () => {
    ctx = await createTestSession({
      additionalExtensionPaths: [
        resolve(import.meta.dirname, "fixtures/broken-handler-extension.ts"),
      ],
    });

    await ctx.session.prompt("Say hello");

    // Wait for envelopes — we expect both a transaction AND an error event
    // The transaction comes from the normal trace, the error from the broken handler
    await ctx.server.waitForEnvelopes(2, 15_000);

    // Verify the error event was captured
    const errors = ctx.server.getErrorEvents();
    expect(errors.length).toBeGreaterThan(0);

    // Find the extension error
    const extensionError = errors.find((e: any) => {
      const exceptionValues = e.exception?.values ?? [];
      return exceptionValues.some(
        (v: any) =>
          v.value?.includes("Handler exploded during turn_start") ||
          v.value?.includes("Extension error"),
      );
    });
    expect(extensionError).toBeDefined();

    // Verify the error has extension context tags
    const tags = (extensionError as any)?.tags ?? {};
    expect(tags["pi.extension.event"]).toBe("turn_start");
    expect(tags["pi.extension.path"]).toContain("broken-handler-extension");

    // Verify traces still work despite the error
    const txns = ctx.server.getTransactions();
    expect(txns.length).toBeGreaterThan(0);
  });
});
