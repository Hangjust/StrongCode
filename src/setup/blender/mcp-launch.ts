import path from "node:path";
import { blenderConfigConflict, objectRecord } from "./config-merge-shared";

export const BLENDER_MANAGED_MARKER = "strongcode:blender-managed";

export type BlenderManagedPaths = {
  readonly pythonPath: string;
  readonly wrapperPath: string;
  readonly privateConfigPath: string;
};

export type BlenderMcpLaunch =
  | {
    readonly flavor: "legacy";
    readonly pythonPath: string;
    readonly wrapperPath: string;
    readonly privateConfigPath: string;
  }
  | {
    readonly flavor: "official";
    readonly pythonPath: string;
    readonly launcherPath: string;
    readonly privateConfigPath: string;
  };

export type BlenderMcpTransitionProof = {
  readonly predecessorFlavor: BlenderMcpLaunch["flavor"];
  readonly proof: typeof BLENDER_MANAGED_MARKER;
};

export type BlenderMcpLaunchInput = BlenderMcpLaunch | BlenderManagedPaths;

function unsupportedLaunch(launch: never): never {
  throw blenderConfigConflict(`Unsupported Blender MCP launch: ${JSON.stringify(launch)}`);
}

export function normalizedBlenderMcpLaunch(launch: BlenderMcpLaunchInput): BlenderMcpLaunch {
  if (!("flavor" in launch)) return { flavor: "legacy", ...launch };
  switch (launch.flavor) {
    case "legacy":
    case "official":
      return launch;
    default:
      return unsupportedLaunch(launch);
  }
}

export function blenderMcpLaunchFlavor(launch?: BlenderMcpLaunchInput): BlenderMcpLaunch["flavor"] {
  return launch === undefined ? "legacy" : normalizedBlenderMcpLaunch(launch).flavor;
}

function absolute(filePath: string, label: string): string {
  if (!path.isAbsolute(filePath)) {
    throw blenderConfigConflict(`Managed Blender ${label} must be absolute: ${filePath}`);
  }
  return filePath;
}

export function managedBlenderServer(launchInput: BlenderMcpLaunchInput): Record<string, unknown> {
  const launch = normalizedBlenderMcpLaunch(launchInput);
  const pythonPath = absolute(launch.pythonPath, "pythonPath");
  let command: readonly string[];
  switch (launch.flavor) {
    case "legacy":
      command = [
        pythonPath,
        "-I",
        absolute(launch.wrapperPath, "wrapperPath"),
        "--config",
        absolute(launch.privateConfigPath, "privateConfigPath")
      ];
      break;
    case "official":
      command = [pythonPath, "-I", absolute(launch.launcherPath, "launcherPath"), "--strongcode-config",
        absolute(launch.privateConfigPath, "privateConfigPath")];
      break;
    default:
      return unsupportedLaunch(launch);
  }
  return {
    description: BLENDER_MANAGED_MARKER,
    enabled: true,
    autoStart: false,
    type: "local",
    readOnly: false,
    command,
    inheritDefaultEnvironment: false,
    environmentFromEnv: [],
    timeout: { startupMs: 30000, requestMs: 180000 }
  };
}

function generatedServerShape(server: Record<string, unknown>): boolean {
  const timeout = objectRecord(server["timeout"]);
  const environment = server["environmentFromEnv"];
  return Object.keys(server).length === 9
    && server["description"] === BLENDER_MANAGED_MARKER
    && server["autoStart"] === false
    && server["type"] === "local"
    && server["readOnly"] === false
    && server["inheritDefaultEnvironment"] === false
    && Array.isArray(environment)
    && environment.length === 0
    && timeout?.["startupMs"] === 30000
    && timeout["requestMs"] === 180000;
}

export function managedBlenderServerFlavor(serverId: string, value: unknown): BlenderMcpLaunch["flavor"] | undefined {
  if (serverId !== "blender") return undefined;
  const server = objectRecord(value);
  if (server === undefined || !generatedServerShape(server)) return undefined;
  const command = server["command"];
  if (!Array.isArray(command) || !command.every(part => typeof part === "string")) return undefined;
  if (command.length === 5
    && command[1] === "-I"
    && command[3] === "--config"
    && path.isAbsolute(command[0] ?? "")
    && path.isAbsolute(command[2] ?? "")
    && path.isAbsolute(command[4] ?? "")) return "legacy";
  if (command.length === 5
    && command[1] === "-I"
    && command[3] === "--strongcode-config"
    && path.isAbsolute(command[0] ?? "")
    && path.isAbsolute(command[2] ?? "")
    && path.isAbsolute(command[4] ?? "")) return "official";
  return undefined;
}

export function assertBlenderTransitionAuthorized(
  predecessorFlavor: BlenderMcpLaunch["flavor"],
  successorFlavor: BlenderMcpLaunch["flavor"],
  transition: BlenderMcpTransitionProof | undefined
): void {
  if (predecessorFlavor === successorFlavor) return;
  if (transition?.predecessorFlavor !== predecessorFlavor || transition.proof !== BLENDER_MANAGED_MARKER) {
    throw blenderConfigConflict(
      `Blender MCP transition from '${predecessorFlavor}' to '${successorFlavor}' requires matching managed predecessor proof`
    );
  }
}
