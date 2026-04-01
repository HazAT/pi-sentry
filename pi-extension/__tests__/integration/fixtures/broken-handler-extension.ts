import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function brokenHandlerExtension(pi: ExtensionAPI) {
  pi.on("turn_start", () => {
    throw new Error("Handler exploded during turn_start");
  });
}
