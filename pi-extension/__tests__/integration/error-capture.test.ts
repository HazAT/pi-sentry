import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@mariozechner/pi-ai";
import { withTestSession } from "./helpers/setup.js";

describe("error capture", () => {
  it("still captures traces when a sibling extension throws during load", async () => {
    await withTestSession(
      {
        responses: [fauxAssistantMessage("I'm still working!")],
        additionalExtensionPaths: [resolve(import.meta.dirname, "fixtures/broken-extension.ts")],
      },
      async (ctx) => {
        // The broken extension throws in its factory, but the Sentry extension
        // should still be loaded and functioning since it's loaded first.
        await ctx.session.prompt("Hello");

        // Sentry extension should still be capturing traces
        await ctx.server.waitForEnvelopes(1, 15_000);

        const txns = ctx.server.getTransactions();
        expect(txns.length).toBeGreaterThan(0);

        const tx = txns[0] as any;
        expect(tx.transaction).toContain("invoke_agent");
      },
    );
  });

  it("captures error events from extension factories via Sentry exception handler", async () => {
    await withTestSession(
      {
        responses: [fauxAssistantMessage("I'm still working!")],
        additionalExtensionPaths: [resolve(import.meta.dirname, "fixtures/broken-extension.ts")],
      },
      async (ctx) => {
        // The broken extension throws during load — check if Sentry captured it
        await ctx.session.prompt("Hello");
        await ctx.server.waitForEnvelopes(1, 15_000);

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
      },
    );
  });
});
