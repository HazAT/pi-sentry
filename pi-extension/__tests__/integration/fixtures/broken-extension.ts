import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function brokenExtension(_pi: ExtensionAPI) {
  throw new Error("Extension factory exploded");
}
