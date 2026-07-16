import type {
  ProbeProcessAdapter,
  ProbeProcessRequest
} from "../types";

export type AssociationCommandOptions = {
  readonly runner: ProbeProcessAdapter;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxCandidates: number;
};

export async function runAssociationCommand(
  options: AssociationCommandOptions,
  executable: string,
  args: readonly string[]
): Promise<string | undefined> {
  const request: ProbeProcessRequest = {
    executable,
    args,
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
    shell: false
  };
  const result = await options.runner.run(request);
  if (result.kind !== "completed" || result.exitCode !== 0) return undefined;
  const outputBytes = Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8");
  return outputBytes <= options.maxOutputBytes ? result.stdout : undefined;
}
