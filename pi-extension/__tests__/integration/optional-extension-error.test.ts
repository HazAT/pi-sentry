import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import piSentryMonitor from "../../index.js";

function createMockPi() {
  const registeredEvents: string[] = [];
  let extensionErrorRegistrationAttempted = false;

  return {
    get registeredEvents() {
      return registeredEvents;
    },
    get extensionErrorRegistrationAttempted() {
      return extensionErrorRegistrationAttempted;
    },
    registerMessageRenderer() {},
    registerTool() {},
    sendMessage() {},
    sendUserMessage() {},
    on(event: string) {
      if (event === "extension_error") {
        extensionErrorRegistrationAttempted = true;
        throw new Error("extension_error is not supported");
      }
      registeredEvents.push(event);
    },
  };
}

describe("optional extension_error support", () => {
  const prevCwd = process.cwd();
  let tempRoot: string | undefined;

  afterEach(() => {
    process.chdir(prevCwd);
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it("continues loading when extension_error registration is unavailable", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "pi-sentry-"));
    mkdirSync(join(tempRoot, ".pi"), { recursive: true });
    writeFileSync(
      join(tempRoot, ".pi", "sentry.json"),
      JSON.stringify({
        dsn: "http://test@example.invalid/1",
        recordInputs: false,
        recordOutputs: false,
      }),
    );
    process.chdir(tempRoot);

    const pi = createMockPi();

    await expect(piSentryMonitor(pi as any)).resolves.toBeUndefined();
    expect(pi.extensionErrorRegistrationAttempted).toBe(true);
    expect(pi.registeredEvents).toContain("session_start");
  });
});
