import type { Agent } from "../agent";
import type { EffectiveToolPermission, RuntimeContext } from "../../runtime/context";
import type { ToolRegistry } from "../../tools/registry";
import type { AnalysisFinding, AnalysisRequest } from "./contracts";
import type { PreflightRole } from "./metadata";
import type { PreflightGapCode, PreflightLimits, PreflightStage } from "./scheduler-types";

export type PreflightResearchOutcome =
  | Readonly<{ kind: "finding"; finding: AnalysisFinding }>
  | Readonly<{ kind: "gap"; code: PreflightGapCode }>;

export type PreflightResearchEvidence = Readonly<{
  index: number;
  request: AnalysisRequest;
  outcome: PreflightResearchOutcome;
}>;

export type PreflightExecutionInput = Readonly<{
  agent: Agent;
  role: PreflightRole;
  stage: PreflightStage;
  sessionId: string;
  prompt: string;
  userContent?: readonly string[];
  context: RuntimeContext;
  toolRegistry: ToolRegistry;
  signal: AbortSignal;
  effectivePermissions?: Readonly<Record<string, EffectiveToolPermission>>;
  limits: PreflightLimits;
  mode?: "tools" | "finalizer";
  outboundWebAllowed?: boolean;
}>;

export type PreflightExecutionCompletion = Readonly<{
  finalText: string;
  producingAttemptId: string;
  firstAttemptId: string;
  workspaceEvidenceObserved: boolean;
}>;
