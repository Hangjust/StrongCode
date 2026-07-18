import { randomBytes, randomInt } from "node:crypto";
import { z } from "zod";

export const OFFICIAL_BRIDGE_HOST = "127.0.0.1" as const;
export const OFFICIAL_BRIDGE_MIN_PORT = 49_152;
export const OFFICIAL_BRIDGE_MAX_PORT = 65_535;

export const officialPrivateConfigSchema = z.object({
  schemaVersion: z.literal(1),
  profileId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  host: z.literal(OFFICIAL_BRIDGE_HOST),
  port: z.number().int().min(OFFICIAL_BRIDGE_MIN_PORT).max(OFFICIAL_BRIDGE_MAX_PORT),
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/u)
}).strict().readonly();

export type OfficialPrivateConfig = z.infer<typeof officialPrivateConfigSchema>;

export function createOfficialPrivateConfig(options: {
  readonly profileId: string;
  readonly secret?: Buffer;
  readonly port?: number;
}): OfficialPrivateConfig {
  return officialPrivateConfigSchema.parse({
    schemaVersion: 1,
    profileId: options.profileId,
    host: OFFICIAL_BRIDGE_HOST,
    port: options.port ?? randomInt(OFFICIAL_BRIDGE_MIN_PORT, OFFICIAL_BRIDGE_MAX_PORT + 1),
    secret: (options.secret ?? randomBytes(32)).toString("base64url")
  });
}

export function serializeOfficialPrivateConfig(config: OfficialPrivateConfig): string {
  return `${JSON.stringify(config)}\n`;
}
