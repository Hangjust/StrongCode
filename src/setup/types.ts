import type { StrongCodeConfig } from "../config/schema";
import type { BlenderIntegrationFlavor } from "./blender/selection";

export const SETUP_SCHEMA_VERSION = 3 as const;
export const BLENDER_OFFER_VERSION = 2 as const;

export type VoiceToTextChoice = "yes" | "no" | "maybe";

export type InstalledBlenderIntegration = {
  readonly flavor: BlenderIntegrationFlavor;
  readonly profileId: string;
  readonly version: string;
  readonly executablePath: string;
  readonly receiptPath: string;
  readonly installedAt: string;
};

export type SetupState = {
  readonly schemaVersion: typeof SETUP_SCHEMA_VERSION;
  readonly completed: boolean;
  readonly completedAt?: string;
  readonly selectedProviders: readonly string[];
  readonly deepSeekConfigured: boolean;
  readonly gemmaConfigured: boolean;
  readonly mockOnlyConfirmed: boolean;
  readonly voiceToText: VoiceToTextChoice;
  readonly blender?: InstalledBlenderIntegration;
  readonly blenderOfferVersion?: number;
};

export interface SetupChoice {
  value: string;
  label: string;
  hint?: string;
}

export interface SetupStatus {
  stop(message?: string, state?: "success" | "error"): void;
}

export interface SetupPrompter {
  intro(message: string): void;
  note(message: string): void;
  outro(message: string): void;
  status?(message: string): SetupStatus;
  select(message: string, choices: SetupChoice[], initialValue?: string): Promise<string>;
  multiselect(message: string, choices: SetupChoice[], initialValues?: string[]): Promise<string[]>;
  text(message: string, options?: { initialValue?: string; placeholder?: string; validate?: (value: string) => string | undefined }): Promise<string>;
  secret(message: string, options?: { optional?: boolean }): Promise<string>;
  confirm(message: string, initialValue?: boolean): Promise<boolean>;
  close(): void;
}

export interface SetupResult {
  status: "completed" | "already-complete" | "cancelled";
  state: SetupState;
  config?: StrongCodeConfig;
  warnings: string[];
}

export class SetupCancelledError extends Error {
  constructor() {
    super("Setup cancelled");
    this.name = "SetupCancelledError";
  }
}
