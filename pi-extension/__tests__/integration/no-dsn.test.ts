import { afterAll, describe, expect, it } from "vitest";
import { createTestSession, type TestSessionContext } from "./helpers/setup.js";

describe("no DSN configured", () => {
  let ctx: TestSessionContext;

  afterAll(async () => {
    await ctx?.cleanup();
  });

  it("sends no envelopes but sentry tool is still available", async () => {
    ctx = await createTestSession({ dsn: null });

    await ctx.session.prompt("Say hello");

    // Give time for any envelopes that shouldn't arrive
    await new Promise((r) => setTimeout(r, 2_000));

    expect(ctx.server.envelopes.length).toBe(0);

    // Verify the sentry tool is still registered
    const tools = ctx.session.agent.state.tools;
    const sentryTool = tools.find((t: any) => t.name === "sentry");
    expect(sentryTool).toBeDefined();
  });
});
