import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

const toolSchema = z.array(z.object({ name: z.string().min(1) }).passthrough()).min(1);

export type OfficialMcpProbeRequest = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly startupTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly shell: false;
};

export interface OfficialMcpProbeAdapter {
  probe(request: OfficialMcpProbeRequest): Promise<unknown>;
}

export class OfficialMcpProbeError extends Error { readonly name = "OfficialMcpProbeError"; }

export const nodeOfficialMcpProbeAdapter: OfficialMcpProbeAdapter = {
  async probe(request) {
    const transport = new StdioClientTransport({ command: request.executable, args: [...request.args], cwd: request.cwd, env: request.env, stderr: "pipe" });
    const client = new Client({ name: "strongcode-health-probe", version: "1.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport, { timeout: request.startupTimeoutMs });
      return (await client.listTools(undefined, { timeout: request.requestTimeoutMs })).tools;
    } finally {
      await boundedClose(client);
    }
  }
};

async function boundedClose(client: Client): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([client.close(), new Promise<void>(resolve => {
      timer = setTimeout(resolve, 2_000);
      timer.unref();
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function probeOfficialBlenderMcp(options: {
  readonly pythonPath: string;
  readonly launcherPath: string;
  readonly privateConfigPath: string;
  readonly cwd: string;
  readonly adapter?: OfficialMcpProbeAdapter;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<readonly string[]> {
  const env = scrubEnvironment(options.env);
  const request: OfficialMcpProbeRequest = { executable: options.pythonPath,
    args: ["-I", options.launcherPath, "--strongcode-config", options.privateConfigPath], cwd: options.cwd, env,
    startupTimeoutMs: 15_000, requestTimeoutMs: 15_000, shell: false };
  const parsed = toolSchema.safeParse(await (options.adapter ?? nodeOfficialMcpProbeAdapter).probe(request));
  if (!parsed.success) throw new OfficialMcpProbeError("Official Blender MCP initialize/tools-list handshake was invalid");
  return parsed.data.map(tool => tool.name).sort();
}

function scrubEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = { PIP_CONFIG_FILE: "NUL", PIP_NO_INDEX: "1", PYTHONNOUSERSITE: "1", PYTHONPATH: "", PYTHONUTF8: "1", DO_NOT_TRACK: "1", SCARF_NO_ANALYTICS: "true", POSTHOG_DISABLED: "true" };
  for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"] as const) {
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}
