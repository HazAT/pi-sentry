export interface ExecFn {
  (command: string, args: string[], options?: { timeout?: number; cwd?: string }): Promise<{
    stdout: string;
    stderr: string;
    code: number;
    killed: boolean;
  }>;
}

export interface CLIResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface SentryCLI {
  run(command: string, options?: { timeout?: number; cwd?: string }): Promise<CLIResult>;
}

/**
 * Split a command string into args, respecting single and double quotes.
 * e.g. `issue list --query "is:unresolved assigned:me"` → ["issue", "list", "--query", "is:unresolved assigned:me"]
 */
function splitCommand(command: string): string[] {
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

export function createSentryCLI(exec: ExecFn): SentryCLI {
  return {
    async run(command, options) {
      const args = ["sentry@latest", ...splitCommand(command)];
      const result = await exec("npx", args, options);
      return { stdout: result.stdout, stderr: result.stderr, code: result.code };
    },
  };
}
