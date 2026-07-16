import { StrongCodeError } from "../../core/errors";

export type RequestedTerminal = "cancelled" | "timeout" | "failure";
type TerminalAuthorityState =
  | Readonly<{ kind: "open" }>
  | Readonly<{ kind: "requested"; terminal: RequestedTerminal }>
  | Readonly<{ kind: "success-claimed" }>
  | Readonly<{ kind: "durable"; terminal: RequestedTerminal | "success" }>;

export class PreflightTerminalAuthority {
  private state: TerminalAuthorityState = { kind: "open" };

  request(terminal: RequestedTerminal): boolean {
    if (this.state.kind === "open") {
      this.state = { kind: "requested", terminal };
      return true;
    }
    return this.state.kind === "requested" && this.state.terminal === terminal;
  }

  tryClaimSuccess(): boolean {
    if (this.state.kind !== "open") return false;
    this.state = { kind: "success-claimed" };
    return true;
  }

  markDurable(terminal: RequestedTerminal | "success"): void {
    const valid = this.state.kind === "success-claimed"
      ? terminal === "success"
      : this.state.kind === "requested" && this.state.terminal === terminal;
    if (!valid) throw new StrongCodeError("MODEL_ERROR", "Invalid preflight terminal transition");
    this.state = { kind: "durable", terminal };
  }
}
