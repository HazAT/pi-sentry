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

export function createSentryCLI(exec: ExecFn): SentryCLI {
  return {
    async run(command, options) {
      const args = ["sentry@latest", ...command.split(/\s+/).filter(Boolean)];
      const result = await exec("npx", args, options);
      return { stdout: result.stdout, stderr: result.stderr, code: result.code };
    },
  };
}
