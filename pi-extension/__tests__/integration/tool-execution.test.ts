import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { withTestSession } from "./helpers/setup.js";

describe("tool execution trace", () => {
  it("captures execute_tool spans for tool calls", async () => {
    await withTestSession(
      {
        recordInputs: true,
        responses: [
          // First response: call the test tool
          fauxAssistantMessage([fauxToolCall("test_tool", { input: "hello" })], {
            stopReason: "toolUse",
          }),
          // Second response: final text after tool result
          fauxAssistantMessage("Done! The tool returned a result."),
        ],
        extensionFactories: [
          (pi) => {
            pi.registerTool({
              name: "test_tool",
              label: "Test Tool",
              description: "A test tool for integration testing",
              parameters: Type.Object({
                input: Type.String({ description: "Input value" }),
              }),
              async execute(_toolCallId, params) {
                return {
                  content: [{ type: "text", text: `Processed: ${params.input}` }],
                  details: {},
                };
              },
            });
          },
        ],
      },
      async (ctx) => {
        await ctx.session.prompt("Use the test tool with input hello");

        await ctx.server.waitForEnvelopes(1, 15_000);

        const spans = ctx.server.getSpans();

        // Find execute_tool span
        const toolSpan = spans.find(
          (s: any) =>
            s.op === "gen_ai.execute_tool" || s.data?.["gen_ai.operation.name"] === "execute_tool",
        );
        expect(toolSpan).toBeDefined();

        // Check tool name
        const data = (toolSpan as any)?.data ?? {};
        expect(data["gen_ai.tool.name"]).toBe("test_tool");
        expect(data["gen_ai.tool.type"]).toBe("function");

        // Check tool input was recorded
        expect(data["gen_ai.tool.input"]).toBeTruthy();
      },
    );
  });
});
