import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function brokenToolCallExtension(pi: ExtensionAPI) {
  pi.on("tool_call", () => {
    throw new Error("tool_call handler crashed");
  });
}
