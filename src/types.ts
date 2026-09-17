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
}

export interface WatchdogPacket {
  revision: number;
  phase: WatchdogPhase;
  instructions: Evidence[];
  evidence: Evidence[];
  omitted: boolean;
}

export interface WatchdogCheck {
  kind: "verification" | "instruction";
  verdict: "clear" | "concern" | "insufficient";
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
