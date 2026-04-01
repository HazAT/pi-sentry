import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { withTestSession } from "./helpers/setup.js";

describe("tool_call handler crash", () => {
  it("does not crash pi when a tool_call handler throws", async () => {
    await withTestSession(
      {
        responses: [
          // Model calls a tool — triggers the broken tool_call handler
          fauxAssistantMessage([fauxToolCall("test_tool", { input: "hello" })], {
            stopReason: "toolUse",
          }),
          // Model responds after tool result — proves the agent loop survived
          fauxAssistantMessage("Tool completed successfully."),
        ],
        additionalExtensionPaths: [
          resolve(import.meta.dirname, "fixtures/broken-toolcall-extension.ts"),
        ],
        extensionFactories: [
          (pi) => {
            pi.registerTool({
              name: "test_tool",
              label: "Test Tool",
              description: "A test tool",
              parameters: Type.Object({
                input: Type.String({ description: "Input value" }),
              }),
              async execute(_toolCallId, params) {
                return {
                  content: [{ type: "text", text: `Result: ${params.input}` }],
                  details: {},
                };
              },
            });
          },
        ],
      },
      async (ctx) => {
        // This would previously crash the process.
        // With the try/catch patch on emitToolCall, it survives and completes.
        await ctx.session.prompt("Use the test tool");

        await ctx.server.waitForEnvelopes(2, 15_000);

        // Verify the error was captured by Sentry
        const errors = ctx.server.getErrorEvents();
        expect(errors.length).toBeGreaterThan(0);

        const toolCallError = errors.find((e: any) => {
          const values = e.exception?.values ?? [];
          return values.some((v: any) => v.value?.includes("tool_call handler crashed"));
        });
        expect(toolCallError).toBeDefined();

        // Verify the tag identifies it as a tool_call error
        expect((toolCallError as any)?.tags?.["pi.extension.event"]).toBe("tool_call");

        // Verify the agent loop completed — we got a transaction with tool execution
        const txns = ctx.server.getTransactions();
        expect(txns.length).toBeGreaterThan(0);

        const spans = ctx.server.getSpans();
        const toolSpan = spans.find((s: any) => s.op === "gen_ai.execute_tool");
        expect(toolSpan).toBeDefined();
      },
    );
  });
});
