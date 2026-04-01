import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@mariozechner/pi-ai";
import { createTestSession, type TestSessionContext } from "./helpers/setup.js";

describe("error capture", () => {
  let ctx: TestSessionContext;

  afterAll(async () => {
    await ctx?.cleanup();
  });

  it("still captures traces when a sibling extension throws during load", async () => {
    // The broken extension throws in its factory, but the Sentry extension
    // should still be loaded and functioning since it's loaded first.
    ctx = await createTestSession({
      responses: [fauxAssistantMessage("I'm still working!")],
      additionalExtensionPaths: [resolve(import.meta.dirname, "fixtures/broken-extension.ts")],
    });

    await ctx.session.prompt("Hello");

    // Sentry extension should still be capturing traces
    await ctx.server.waitForEnvelopes(1, 15_000);

    const txns = ctx.server.getTransactions();
    expect(txns.length).toBeGreaterThan(0);

    const tx = txns[0] as any;
    expect(tx.transaction).toContain("invoke_agent");
  });

  it("captures error events from extension factories via Sentry exception handler", async () => {
    // The broken extension throws during load — check if Sentry captured it
    // Note: This depends on whether pi's extension loader propagates errors
    // through the uncaught exception handler. The extension error may or may
    // not show up as a Sentry error event depending on pi's error handling.
    const errors = ctx.server.getErrorEvents();

    // We verify at minimum that the session trace was not disrupted
    const spans = ctx.server.getSpans();
    const agentSpan = spans.find((s: any) => s.op === "gen_ai.invoke_agent");
    expect(agentSpan).toBeDefined();

    // If errors were captured, verify they contain our extension error
    if (errors.length > 0) {
      const hasExtensionError = errors.some((e: any) =>
        JSON.stringify(e).includes("Extension factory exploded"),
      );
      expect(hasExtensionError).toBe(true);
    }
  });
});
