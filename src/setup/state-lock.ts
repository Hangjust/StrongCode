import { setTimeout as delay } from "node:timers/promises";
import { StrongCodeError } from "../core/errors";
import { BlenderInstallError } from "./blender/durable-fs";
import { acquireBlenderInstallLock, type BlenderInstallLock } from "./blender/install-lock";

const LOCK_ATTEMPTS = 100;
const LOCK_RETRY_MS = 10;
const SETUP_STATE_LOCK_ID = "setup-state";

export async function acquireSetupStateLock(homePath: string): Promise<BlenderInstallLock> {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      return await acquireBlenderInstallLock(homePath, SETUP_STATE_LOCK_ID);
    } catch (error) {
      const active = error instanceof BlenderInstallError
        && error.reason === "conflict"
        && error.message.startsWith("Another Blender installation is already running");
      if (!active) throw error;
      await delay(LOCK_RETRY_MS);
    }
  }
  throw new StrongCodeError("CONFIG_ERROR", "Timed out waiting to update setup state");
}
