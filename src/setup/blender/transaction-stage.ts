import { createHash } from "node:crypto";
import path from "node:path";
import {
  BlenderInstallError,
  canonicalTargetPath,
  copyPathDurable,
  pathState,
  writeDurableFile
} from "./durable-fs";
import type { ActivationPhase, BlenderInstallTarget, PathState } from "./journal-schema";
import { layoutFromJournalPath } from "./journal-store";
import { writePrivateFile } from "./private-files";

export type StagedTarget =
  | { readonly kind: "absent" }
  | { readonly kind: "file"; readonly content: string | Buffer }
  | { readonly kind: "directory"; readonly sourcePath: string };

export type BlenderInstallTargetPlan = {
  readonly canonicalPath: string;
  readonly activationPhase: ActivationPhase;
  readonly staged: StagedTarget;
  readonly private?: boolean;
  readonly requiredPreState: PathState;
};

export function stagedBlenderInstallTargetPath(journalPath: string, target: BlenderInstallTarget): string {
  return path.join(layoutFromJournalPath(journalPath).stageDirectory, `${target.targetId}.${target.expectedPost.kind}`);
}

export async function stageBlenderInstallTarget(
  stageDirectory: string,
  plan: BlenderInstallTargetPlan
): Promise<BlenderInstallTarget> {
  const canonicalPath = await canonicalTargetPath(plan.canonicalPath);
  const identity = process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
  const targetId = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  const privateFile = plan.private ?? false;
  if (privateFile && plan.staged.kind === "directory") {
    throw new BlenderInstallError("unsafe-path", "Private Blender targets must be regular files");
  }
  if (plan.staged.kind === "absent" && plan.requiredPreState.kind === "absent") {
    throw new BlenderInstallError("conflict", "Removal targets require an exact present pre-state");
  }
  const destination = path.join(stageDirectory, `${targetId}.${plan.staged.kind}`);
  let expectedPost: PathState;
  switch (plan.staged.kind) {
    case "absent":
      expectedPost = { kind: "absent" };
      break;
    case "file":
      if (privateFile) await writePrivateFile(destination, plan.staged.content);
      else await writeDurableFile(destination, plan.staged.content, 0o600);
      expectedPost = await pathState(destination);
      break;
    case "directory":
      await copyPathDurable(plan.staged.sourcePath, destination);
      expectedPost = await pathState(destination);
      break;
    default: {
      const unsupported: never = plan.staged;
      throw new BlenderInstallError("invalid-journal", `Unsupported staged target: ${JSON.stringify(unsupported)}`);
    }
  }
  const current = await pathState(canonicalPath);
  if (expectedPost.kind !== "absent" && current.kind !== "absent" && current.kind !== expectedPost.kind) {
    throw new BlenderInstallError("conflict", `Refusing managed target path type change: ${canonicalPath}`);
  }
  return {
    targetId,
    canonicalPath,
    activationPhase: plan.activationPhase,
    private: privateFile,
    status: "staged",
    requiredPreState: plan.requiredPreState,
    preState: null,
    backup: null,
    expectedPost,
    conflict: null
  };
}
