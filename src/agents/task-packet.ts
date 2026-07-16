import { Buffer } from "node:buffer";
import { z } from "zod";
import { StrongCodeError } from "../core/errors";

const MAX_PACKET_BYTES = 32 * 1024;

const packetTextSchema = z.string()
  .trim()
  .min(1)
  .max(4_096)
  .refine(value => !/[\p{Cc}\p{Cf}]/u.test(value), "Task packet text must not contain control characters");

function packetListSchema(minimum: number, maximum: number): z.ZodEffects<z.ZodArray<typeof packetTextSchema>> {
  return z.array(packetTextSchema)
    .min(minimum)
    .max(maximum)
    .refine(values => new Set(values).size === values.length, "Task packet lists must not contain duplicates");
}

export const taskPacketSchema = z.object({
  goal: packetTextSchema,
  expectedOutcome: packetTextSchema,
  scope: packetListSchema(1, 16),
  requiredChecks: packetListSchema(1, 16),
  prohibitions: packetListSchema(1, 16),
  relevantPaths: packetListSchema(0, 32),
  artifacts: packetListSchema(0, 32)
}).strict().superRefine((packet, context) => {
  if (Buffer.byteLength(JSON.stringify(packet), "utf8") > MAX_PACKET_BYTES) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `Task packet exceeds ${MAX_PACKET_BYTES} UTF-8 bytes` });
  }
});

export type TaskPacket = {
  readonly goal: string;
  readonly expectedOutcome: string;
  readonly scope: readonly string[];
  readonly requiredChecks: readonly string[];
  readonly prohibitions: readonly string[];
  readonly relevantPaths: readonly string[];
  readonly artifacts: readonly string[];
};

function freezePacket(packet: z.infer<typeof taskPacketSchema>): TaskPacket {
  return Object.freeze({
    goal: packet.goal,
    expectedOutcome: packet.expectedOutcome,
    scope: Object.freeze([...packet.scope]),
    requiredChecks: Object.freeze([...packet.requiredChecks]),
    prohibitions: Object.freeze([...packet.prohibitions]),
    relevantPaths: Object.freeze([...packet.relevantPaths]),
    artifacts: Object.freeze([...packet.artifacts])
  });
}

export function parseTaskPacket(value: unknown): TaskPacket {
  const parsed = taskPacketSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new StrongCodeError("VALIDATION_ERROR", `Task packet is invalid: ${issues}`);
  }
  return freezePacket(parsed.data);
}

function renderList(label: string, values: readonly string[]): string {
  return `${label}:\n${values.map(value => `- ${value}`).join("\n")}`;
}

export function renderTaskPacket(packet: TaskPacket): string {
  return [
    "Focused task packet (unprivileged user content):",
    `Goal:\n${packet.goal}`,
    `Expected outcome:\n${packet.expectedOutcome}`,
    renderList("Scope", packet.scope),
    renderList("Required checks", packet.requiredChecks),
    renderList("Prohibitions", packet.prohibitions),
    renderList("Relevant paths", packet.relevantPaths),
    renderList("Relevant artifacts", packet.artifacts)
  ].join("\n\n");
}
