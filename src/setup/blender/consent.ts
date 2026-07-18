import { StrongCodeError } from "../../core/errors";
import type {
  BlenderIntegrationSelection,
  LegacyBlenderIntegrationSelection,
  OfficialBlenderIntegrationSelection
} from "./selection";

function unsupportedSelection(selection: never): never {
  throw new StrongCodeError("CONFIG_ERROR", `Unsupported Blender integration selection: ${JSON.stringify(selection)}`);
}

export function blenderIntegrationConsentDetails(
  selection: OfficialBlenderIntegrationSelection,
  addonSha256: string,
  mcpbSha256: string
): string;
export function blenderIntegrationConsentDetails(
  selection: LegacyBlenderIntegrationSelection,
  wheelSha256: string,
  addonSha256: string
): string;
export function blenderIntegrationConsentDetails(
  selection: BlenderIntegrationSelection,
  wheelSha256?: string,
  addonSha256?: string
): string {
  const profile = selection.profile;
  switch (selection.flavor) {
    case "legacy":
      if (wheelSha256 === undefined || addonSha256 === undefined) {
        throw new StrongCodeError("CONFIG_ERROR", "Legacy Blender consent requires pinned artifact hashes");
      }
      return [
        `Blender: ${profile.executable.canonicalPath} · version ${profile.version} · profile ${profile.profileId}.`,
        `Pinned blender-mcp 1.6.4 · wheel SHA-256 ${wheelSha256} · addon SHA-256 ${addonSha256}.`,
        "StrongCode selects this legacy flavor for stable Blender 4.2 through 5.0; stable Blender 5.1+ uses Blender Lab MCP v1.0.0.",
        "Installs a private StrongCode runtime and persists the addon plus Blender preferences so it auto-enables on future GUI launches.",
        `Persisted Blender targets: addon under ${profile.paths.resources.user}; preferences and private settings under ${profile.paths.config}.`,
        "A GUI launch starts an authenticated ephemeral loopback listener. The Blender MCP is read/write; execute_blender_code remains ask and is denied noninteractively.",
        "Telemetry and remote providers are off. StrongCode does not install Python or uv, create OS autostart, or modify project configuration.",
        "Installation is transactional and includes rollback of managed files and configuration if commit fails."
      ].join("\n");
    case "official":
      if (wheelSha256 === undefined || addonSha256 === undefined) {
        throw new StrongCodeError("CONFIG_ERROR", "Official Blender consent requires pinned artifact hashes");
      }
      return [
        `Blender: ${profile.executable.canonicalPath} · stable version ${profile.version} · profile ${profile.profileId}.`,
        `Selected integration: Blender's official 5.1+ MCP flavor, Blender Lab MCP v1.0.0 · addon SHA-256 ${wheelSha256} · MCPB SHA-256 ${addonSha256}.`,
        "Stable Blender 4.2 through 5.0 uses the legacy blender-mcp 1.6.4 flavor. --force may transactionally migrate only an exactly owned healthy installation between flavors.",
        "Integrity is enforced by StrongCode-maintained SHA-256 pins, not upstream signatures. The root is installed from the verified MCPB, never PyPI, and uv is not installed or executed.",
        "StrongCode keeps Blender Lab MCP v1.0.0 and applies a reviewed authenticated derivative after verifying the exact upstream archives and source contexts.",
        "The derivative uses canonical JSON, a fresh cryptographic nonce, and HMAC-SHA256 for every execute request, rejects replay, and binds only to 127.0.0.1 on a generated high port. Its 32-byte secret exists only in a private profile config file.",
        "All Blender MCP tools use the managed wildcard permission 'ask' and are denied noninteractively. Generated Blender/Python code can modify scenes, files, and application state.",
        `Persisted Blender targets: authenticated extension under ${(profile.paths.extensions ?? "<Blender EXTENSIONS resource>")}/user_default/mcp, private bridge config under ${profile.paths.config}/strongcode_blender_mcp, and preferences at ${profile.paths.config}/userpref.blend.`,
        "The private runtime is stored under StrongCode home at mcps/blender/runtimes/official-1.0.0-cp311-win_amd64; no project config or OS autostart is created.",
        "Installation is transactional: runtime, extension, preferences, permissions, MCP config, and the ownership receipt activate in order with rollback on failure."
      ].join("\n");
    default:
      return unsupportedSelection(selection);
  }
}
