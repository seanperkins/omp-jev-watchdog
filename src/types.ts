export type WatchdogPhase = "working" | "complete";
export type EvidenceKind = "user" | "assistant" | "tool_call" | "tool_result";

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  text: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  truncated?: boolean;
  intermediate?: boolean;
  precedingAssistant?: { text: string; truncated?: boolean };
}

export interface WatchdogPacket {
  revision: number;
  phase: WatchdogPhase;
  instructions: Evidence[];
  evidence: Evidence[];
  omitted: boolean;
  omittedInstructions: boolean;
  omittedEvidence: boolean;
}

export type WatchdogCheckReason =
  | "no_conflict"
  | "verification_contradiction"
  | "instruction_conflict"
  | "missing_evidence"
  | "ambiguous_scope"
  | "truncated_context";

export interface WatchdogCheck {
  kind: "verification" | "instruction";
  verdict: "clear" | "concern" | "insufficient";
  reason: WatchdogCheckReason;
  confidence: number;
  evidenceIds: string[];
  instructionId?: string;
  summary: string;
}

export interface WatchdogResult {
  revision: number;
  phase: WatchdogPhase;
  status: "checked" | "not_checked";
  durationMs: number;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  checks: WatchdogCheck[];
  reason?: "timeout" | "unavailable" | "invalid_response";
}

export interface WatchdogRecord extends WatchdogResult {
  timestamp: string;
  packet: WatchdogPacket;
}
