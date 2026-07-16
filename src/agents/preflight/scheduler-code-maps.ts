import { StrongCodeError } from "../../core/errors";
import type { PreflightProtocolCode } from "./scheduler-protocol";
import type { PreflightFailureCode, PreflightGapCode } from "./scheduler-types";

export function assertNever(value: never): never {
  throw new StrongCodeError("MODEL_ERROR", "Unreachable preflight variant");
}

export function unexpectedProtocolCode(code: PreflightProtocolCode): "internal_error" {
  switch (code) {
    case "orphaned_reservation": case "route_exhausted": case "root_provider_failed":
    case "root_output_too_large": case "root_json_invalid": case "root_decision_invalid":
    case "title_word_limit": case "unsafe_display_text": case "research_limit_exceeded":
    case "research_duplicate_id": case "research_question_too_large": case "research_payload_too_large":
    case "nested_research_denied": case "tool_permission_denied": case "tool_data_boundary_denied": case "tool_step_limit":
    case "tool_total_limit": case "tool_loop_detected": case "tool_input_too_large":
    case "tool_output_budget_exhausted": case "model_step_limit": case "insufficient_finalization_time":
    case "finalizer_route_exhausted": case "finalizer_provider_failed": case "finalizer_tool_requested":
    case "finalizer_output_too_large": case "finalizer_evidence_too_large": case "finalizer_json_invalid":
    case "finalizer_result_invalid": case "provider_identity_collision": case "overall_timeout":
    case "invalid_limit_narrowing": case "internal_error": case "route_unavailable":
    case "provider_failed": case "tool_limit": case "child_timeout": case "insufficient_child_time":
    case "malformed_json": case "finding_invalid": case "finding_mismatch": case "finding_too_large":
      return "internal_error";
    default:
      return assertNever(code);
  }
}

export function childExecutionGap(code: PreflightFailureCode): PreflightGapCode | undefined {
  switch (code) {
    case "tool_permission_denied": case "tool_data_boundary_denied": case "provider_identity_collision": return undefined;
    case "model_step_limit": return "model_step_limit";
    case "tool_step_limit": case "tool_total_limit": case "tool_loop_detected":
    case "tool_input_too_large": case "tool_output_budget_exhausted": return "tool_limit";
    case "orphaned_reservation": case "route_exhausted": case "root_provider_failed":
    case "root_output_too_large": case "root_json_invalid": case "root_decision_invalid":
    case "title_word_limit": case "unsafe_display_text": case "research_limit_exceeded":
    case "research_duplicate_id": case "research_question_too_large": case "research_payload_too_large":
    case "nested_research_denied": case "insufficient_finalization_time": case "finalizer_route_exhausted":
    case "finalizer_provider_failed": case "finalizer_tool_requested": case "finalizer_output_too_large":
    case "finalizer_evidence_too_large": case "finalizer_json_invalid": case "finalizer_result_invalid":
    case "overall_timeout": case "invalid_limit_narrowing": case "internal_error": return "provider_failed";
    default: return assertNever(code);
  }
}
