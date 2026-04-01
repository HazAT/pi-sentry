import { createSentrySDK, SentryError } from "sentry";

export interface CLIResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface SentryCLI {
  run(command: string, options?: { timeout?: number }): Promise<CLIResult>;
  authStatus(): Promise<CLIResult>;
  authLogin(): Promise<CLIResult>;
  issueList(options?: { limit?: number; query?: string }): Promise<unknown>;
}

/**
 * Split a command string into args, respecting single and double quotes.
 * e.g. `issue list --query "is:unresolved assigned:me"` → ["issue", "list", "--query", "is:unresolved assigned:me"]
 */
export function splitCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) {
    args.push(current);
  }
  return args;
}

function formatResult(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

function formatError(error: unknown, fallbackPrefix: string): CLIResult {
  if (error instanceof SentryError) {
    return {
      stdout: "",
      stderr: [error.message, error.stderr].filter(Boolean).join("\n"),
      code: error.exitCode ?? 1,
    };
  }
  return { stdout: "", stderr: `${fallbackPrefix}: ${String(error)}`, code: 1 };
}

export function createSentryCLI(): SentryCLI {
  const sdk = createSentrySDK();

  return {
    async run(command, _options) {
      try {
        const args = splitCommand(command);
        const result = await sdk.run(...args);
        return { stdout: formatResult(result), stderr: "", code: 0 };
      } catch (error) {
        return formatError(error, "Sentry CLI error");
      }
    },

    async authStatus() {
      try {
        const result = await sdk.auth.status();
        return { stdout: formatResult(result), stderr: "", code: 0 };
      } catch (error) {
        return formatError(error, "Auth status error");
      }
    },

    async authLogin() {
      try {
        await sdk.auth.login();
        return { stdout: "Successfully authenticated", stderr: "", code: 0 };
      } catch (error) {
        return formatError(error, "Auth login error");
      }
    },

    async issueList(options) {
      return await sdk.issue.list(options);
    },
  };
}
