import { createHash } from "node:crypto";
import { mcpConfigSchema } from "../../mcp/config";
import { mcpServerNamespace } from "../../mcp/names";
import {
  assertBlenderTransitionAuthorized,
  managedBlenderServer,
  managedBlenderServerFlavor,
  normalizedBlenderMcpLaunch,
  type BlenderMcpLaunchInput,
  type BlenderMcpTransitionProof
} from "./mcp-launch";
import {
  blenderConfigConflict,
  MAX_BLENDER_CONFIG_BYTES,
  objectRecord,
  type SourceMergePlan
} from "./config-merge-shared";
import { canonicalJsonString } from "./semantic-json";

function parseJsonObject(source: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw blenderConfigConflict(`Invalid JSON in global MCP config: ${error.message}`);
    }
    throw error;
  }
  const parsed = mcpConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw blenderConfigConflict(
      `Invalid global MCP config: ${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`
    );
  }
  const object = objectRecord(value);
  if (object === undefined) throw blenderConfigConflict("Global MCP config must be an object");
  return object;
}

function commandIdentifiesBlender(server: unknown): boolean {
  const command = objectRecord(server)?.["command"];
  if (!Array.isArray(command) || !command.every(part => typeof part === "string")) return false;
  const identity = command.join(" ").toLowerCase().replaceAll("\\", "/");
  return identity.includes("blender-mcp")
    || identity.includes("blender_mcp")
    || (identity.includes("strongcode") && identity.includes("blender"));
}

export function mcpFragmentSha256(source: string): string {
  const servers = objectRecord(parseJsonObject(source)["mcpServers"]);
  if (servers === undefined) throw blenderConfigConflict("Global MCP config mcpServers must be an object");
  return createHash("sha256")
    .update(canonicalJsonString({ serverId: "blender", server: servers["blender"] }))
    .digest("hex");
}

export function planBlenderMcpSource(
  source: string,
  launchInput: BlenderMcpLaunchInput,
  transition?: BlenderMcpTransitionProof
): SourceMergePlan {
  if (Buffer.byteLength(source) > MAX_BLENDER_CONFIG_BYTES) {
    throw blenderConfigConflict(`Global MCP config exceeds ${MAX_BLENDER_CONFIG_BYTES} bytes`);
  }
  const config = parseJsonObject(source);
  const servers = objectRecord(config["mcpServers"]);
  if (servers === undefined) throw blenderConfigConflict("Global MCP config mcpServers must be an object");
  const launch = normalizedBlenderMcpLaunch(launchInput);
  let predecessorFlavor: ReturnType<typeof managedBlenderServerFlavor>;
  for (const [serverId, server] of Object.entries(servers)) {
    const managedFlavor = managedBlenderServerFlavor(serverId, server);
    const owned = managedFlavor !== undefined;
    if (mcpServerNamespace(serverId) === "blender" && !owned) {
      throw blenderConfigConflict(`Blender MCP server '${serverId}' conflicts with the managed server and is unowned`);
    }
    if (commandIdentifiesBlender(server) && !owned) {
      throw blenderConfigConflict(`MCP server '${serverId}' has an unowned Blender MCP or StrongCode derivative command`);
    }
    if (serverId === "blender") predecessorFlavor = managedFlavor;
  }
  if (predecessorFlavor !== undefined) {
    assertBlenderTransitionAuthorized(predecessorFlavor, launch.flavor, transition);
  }

  const blender = managedBlenderServer(launch);
  if (canonicalJsonString(servers["blender"]) === canonicalJsonString(blender)) {
    return { changed: false, content: source };
  }
  const next = { ...config, mcpServers: { ...servers, blender } };
  const validated = mcpConfigSchema.safeParse(next);
  if (!validated.success) {
    throw blenderConfigConflict(`Managed Blender MCP merge is invalid: ${validated.error.message}`);
  }
  return { changed: true, content: `${JSON.stringify(next, null, 2)}\n` };
}
