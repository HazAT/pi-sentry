import { afterAll, describe, expect, it } from "vitest";
import { createTestSession, type TestSessionContext } from "./helpers/setup.js";

describe("basic session trace", () => {
  let ctx: TestSessionContext;

  afterAll(async () => {
    await ctx?.cleanup();
  });

  it("captures an invoke_agent transaction with session attributes", async () => {
    ctx = await createTestSession();

    await ctx.session.prompt("Say hello");

    // Wait for Sentry to flush envelopes (transaction + session)
    await ctx.server.waitForEnvelopes(1, 15_000);

    const txns = ctx.server.getTransactions();
    expect(txns.length).toBeGreaterThan(0);

    const spans = ctx.server.getSpans();
    expect(spans.length).toBeGreaterThan(0);

    // Find the invoke_agent span (root transaction span)
    const agentSpan = spans.find(
      (s: any) =>
        s.op === "gen_ai.invoke_agent" || s.data?.["gen_ai.operation.name"] === "invoke_agent",
    );
    expect(agentSpan).toBeDefined();

    // Check session ID attribute exists on the transaction
    const tx = txns[0] as any;
    // Check trace data on the root span (transaction context)
    const traceData = tx.contexts?.trace?.data ?? {};

    // Agent name should be present
    expect(traceData["gen_ai.agent.name"]).toBe("pi");

    // Model should be recorded
    expect(traceData["gen_ai.request.model"]).toBeTruthy();

    // Project name should be present
    expect(traceData["pi.project.name"]).toBeTruthy();

    // Turn index should be recorded
    expect(traceData["pi.turn.index"]).toBeDefined();
  });

  it("captures a gen_ai.request span with token usage", async () => {
    const spans = ctx.server.getSpans();

    // Find request span
    const requestSpan = spans.find(
      (s: any) => s.op === "gen_ai.request" || s.data?.["gen_ai.operation.name"] === "request",
    );
    expect(requestSpan).toBeDefined();

    // Check model attribute
    const data = (requestSpan as any)?.data ?? {};
    expect(data["gen_ai.request.model"]).toBeTruthy();
  });
});
