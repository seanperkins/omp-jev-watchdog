import { type ApiKey, type ChoiceAnswer, type Questions, TypeSafeJudge } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { isRecord } from "@oh-my-pi/pi-utils";
import verificationPrompt from "./prompts/verification.md" with { type: "text" };
import verificationClaimPrompt from "./prompts/verification-claim.md" with { type: "text" };
import verificationEvidencePrompt from "./prompts/verification-evidence.md" with { type: "text" };
import verificationReasonPrompt from "./prompts/verification-reason.md" with { type: "text" };
import instructionPrompt from "./prompts/instruction.md" with { type: "text" };
import instructionEvidencePrompt from "./prompts/instruction-evidence.md" with { type: "text" };
import instructionRulePrompt from "./prompts/instruction-rule.md" with { type: "text" };
import instructionReasonPrompt from "./prompts/instruction-reason.md" with { type: "text" };
import type {
  Evidence,
  WatchdogCheck,
  WatchdogCheckReason,
  WatchdogPacket,
  WatchdogResult,
} from "./types";

export interface EvaluateWatchdogOptions {
  apiKey: ApiKey;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: FetchImpl;
}

const NONE = "__none__";
const VERDICTS = { clear: null, concern: null, insufficient: null };
const REASONS = {
  instruction: {
    no_conflict: null,
    instruction_conflict: null,
    missing_evidence: null,
    ambiguous_scope: null,
    truncated_context: null,
  },
  verification: {
    no_conflict: null,
    verification_contradiction: null,
    missing_evidence: null,
    ambiguous_scope: null,
    truncated_context: null,
  },
};

// Bump the contract marker when non-prompt evaluator semantics change.
export const WATCHDOG_RUBRIC_HASH: string = new Bun.CryptoHasher("sha256")
  .update(
    JSON.stringify([
      "watchdog-evaluator/v2:typed-reasons:strict-choices:paired-citations:truncation-downgrade",
      instructionPrompt,
      instructionEvidencePrompt,
      instructionRulePrompt,
      instructionReasonPrompt,
      verificationPrompt,
      verificationClaimPrompt,
      verificationEvidencePrompt,
      verificationReasonPrompt,
    ]),
  )
  .digest("hex");

function selectors(items: Evidence[]): Record<string, null> {
  return Object.fromEntries([[NONE, null], ...items.map((item) => [item.id, null])]);
}

function validAnswers(value: unknown, questions: Questions): value is Record<string, ChoiceAnswer> {
  if (!isRecord(value) || Object.keys(value).length !== Object.keys(questions).length) return false;
  for (const [id, question] of Object.entries(questions)) {
    const answer = value[id];
    if (question.type !== "choice" || !isRecord(answer) || answer.type !== "choice") return false;
    if (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice))
      return false;
    if (
      typeof answer.confidence !== "number" ||
      !Number.isFinite(answer.confidence) ||
      answer.confidence < 0 ||
      answer.confidence > 1
    )
      return false;
    if (!isRecord(answer.probabilities)) return false;
    const labels = Object.keys(question.criteria);
    if (Object.keys(answer.probabilities).length !== labels.length) return false;
    let sum = 0;
    let highest = 0;
    for (const label of labels) {
      const probability = answer.probabilities[label];
      if (
        typeof probability !== "number" ||
        !Number.isFinite(probability) ||
        probability < 0 ||
        probability > 1
      )
        return false;
      sum += probability;
      highest = Math.max(highest, probability);
    }
    const selected = answer.probabilities[answer.choice];
    if (typeof selected !== "number" || selected < highest || Math.abs(sum - 1) > 0.02)
      return false;
  }
  return true;
}

function validReason(
  kind: WatchdogCheck["kind"],
  verdict: WatchdogCheck["verdict"],
  reason: string | undefined,
  incomplete: boolean,
): reason is WatchdogCheckReason {
  switch (verdict) {
    case "clear":
      return reason === "no_conflict";
    case "concern":
      return (
        reason === (kind === "verification" ? "verification_contradiction" : "instruction_conflict")
      );
    case "insufficient":
      return (
        reason === "missing_evidence" ||
        reason === "ambiguous_scope" ||
        (reason === "truncated_context" && incomplete)
      );
  }
}

function makeCheck(
  kind: WatchdogCheck["kind"],
  answers: Record<string, ChoiceAnswer>,
  sources: Evidence[],
  anchors: Evidence[],
  incomplete: boolean,
): WatchdogCheck | undefined {
  const answer = answers[kind];
  if (answer === undefined) return undefined;
  const source = sources.find((item) => item.id === answers[`${kind}_evidence`]?.choice);
  const anchor = anchors.find(
    (item) => item.id === answers[`${kind}_${kind === "verification" ? "claim" : "rule"}`]?.choice,
  );
  const verdict = answer.choice;
  if (verdict !== "concern" && verdict !== "clear" && verdict !== "insufficient") return undefined;
  const reason = answers[`${kind}_reason`]?.choice;
  if (!validReason(kind, verdict, reason, incomplete)) return undefined;
  if (verdict === "concern" && (source === undefined || anchor === undefined)) return undefined;
  if (verdict !== "concern" && (source !== undefined || anchor !== undefined)) return undefined;
  if (verdict === "concern" && (source?.truncated || anchor?.truncated)) {
    return {
      kind,
      verdict: "insufficient",
      reason: "truncated_context",
      confidence: answer.confidence,
      evidenceIds: [],
      summary: "Selected evidence is truncated; no candidate concern retained.",
    };
  }
  if (verdict === "concern" && source !== undefined && anchor !== undefined) {
    return {
      kind,
      verdict,
      reason,
      confidence: answer.confidence,
      evidenceIds: kind === "verification" ? [anchor.id, source.id] : [source.id],
      ...(kind === "instruction" ? { instructionId: anchor.id } : {}),
      summary:
        kind === "verification"
          ? `Candidate contradiction: assistant claim ${anchor.id} versus tool result ${source.id}.`
          : `Candidate instruction conflict: action/evidence ${source.id} versus user instruction ${anchor.id}.`,
    };
  }
  return {
    kind,
    verdict,
    reason,
    confidence: answer.confidence,
    evidenceIds: [],
    summary:
      verdict === "clear"
        ? "No material conflict identified in supplied evidence."
        : reason === "missing_evidence"
          ? "Required evidence is missing; no candidate concern retained."
          : reason === "ambiguous_scope"
            ? "Evidence scope or chronology is ambiguous; no candidate concern retained."
            : "Context is omitted or truncated; no candidate concern retained.",
  };
}

/** Independent shadow judgment. Confidence is an uncalibrated model signal, not correctness probability. */
export async function evaluateWatchdog(
  packet: WatchdogPacket,
  options: EvaluateWatchdogOptions,
): Promise<WatchdogResult> {
  const started = performance.now();
  const controller = new AbortController();
  let timedOut = false;
  let receivedResponse = false;
  let transportFailed = false;
  const unavailable = (reason: WatchdogResult["reason"]): WatchdogResult => ({
    revision: packet.revision,
    phase: packet.phase,
    durationMs: Math.round(performance.now() - started),
    status: "not_checked",
    inputTokens: 0,
    outputTokens: 0,
    checks: [],
    reason,
  });
  const timeoutMs = options.timeoutMs ?? 1_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return unavailable("timeout");
  if (options.signal?.aborted) return unavailable("unavailable");
  const allEvidence = [...packet.instructions, ...packet.evidence];
  const ids = new Set<string>();
  for (const evidence of allEvidence) {
    if (!evidence.id || evidence.id === NONE || ids.has(evidence.id))
      return unavailable("invalid_response");
    ids.add(evidence.id);
  }
  const instructions = packet.instructions.filter((item) => item.kind === "user");
  const actions = packet.evidence.filter(
    (item) => item.kind === "tool_call" || item.kind === "tool_result",
  );
  const claims = packet.evidence.filter((item) => item.kind === "assistant").slice(-1);
  const results = packet.evidence.filter((item) => item.kind === "tool_result");
  const state = {
    phase: packet.phase,
    omitted: packet.omitted,
    instructions,
    actions,
    verificationClaim: packet.phase === "complete" ? claims[0] : undefined,
  };
  const questions: Questions = {
    instruction: { type: "choice", instructions: instructionPrompt, criteria: VERDICTS },
    instruction_reason: {
      type: "choice",
      instructions: instructionReasonPrompt,
      criteria: REASONS.instruction,
    },
  };
  if (actions.length > 0)
    questions.instruction_evidence = {
      type: "choice",
      instructions: instructionEvidencePrompt,
      criteria: selectors(actions),
    };
  if (instructions.length > 0)
    questions.instruction_rule = {
      type: "choice",
      instructions: instructionRulePrompt,
      criteria: selectors(instructions),
    };
  if (packet.phase === "complete") {
    questions.verification = {
      type: "choice",
      instructions: verificationPrompt,
      criteria: VERDICTS,
    };
    questions.verification_reason = {
      type: "choice",
      instructions: verificationReasonPrompt,
      criteria: REASONS.verification,
    };
    if (claims.length > 0)
      questions.verification_claim = {
        type: "choice",
        instructions: verificationClaimPrompt,
        criteria: selectors(claims),
      };
    if (results.length > 0)
      questions.verification_evidence = {
        type: "choice",
        instructions: verificationEvidencePrompt,
        criteria: selectors(results),
      };
  }
  const abortExternal = (): void => controller.abort();
  const { promise: aborted, reject: rejectAborted } = Promise.withResolvers<never>();
  const onAbort = (): void => rejectAborted(new Error("Watchdog request stopped"));
  controller.signal.addEventListener("abort", onAbort, { once: true });
  options.signal?.addEventListener("abort", abortExternal, { once: true });
  const timer = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    Math.max(0, timeoutMs - (performance.now() - started)),
  );
  const transport = options.fetch ?? fetch;
  const requestFetch: FetchImpl = async (input, init) => {
    try {
      const response = await transport(input, init);
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new Error("Watchdog transport failed");
      }
      receivedResponse = true;
      return response;
    } catch {
      transportFailed = true;
      controller.abort();
      throw new Error("Watchdog transport failed");
    }
  };
  try {
    const judge = new TypeSafeJudge({ apiKey: options.apiKey, fetch: requestFetch, timeoutMs });
    const response = await Promise.race([
      judge.judge({ state: JSON.stringify(state), questions }, { signal: controller.signal }),
      aborted,
    ]);
    if (
      !validAnswers(response.answers, questions) ||
      typeof response.model !== "string" ||
      response.model.trim().length === 0 ||
      !Number.isSafeInteger(response.usage.input) ||
      response.usage.input < 0 ||
      !Number.isSafeInteger(response.usage.output) ||
      response.usage.output < 0
    )
      return unavailable("invalid_response");
    const checks: WatchdogCheck[] = [];
    const incomplete = packet.omitted || allEvidence.some((item) => item.truncated === true);
    if (packet.phase === "complete") {
      const check = makeCheck("verification", response.answers, results, claims, incomplete);
      if (check === undefined) return unavailable("invalid_response");
      checks.push(check);
    }
    const instruction = makeCheck(
      "instruction",
      response.answers,
      actions,
      instructions,
      incomplete,
    );
    if (instruction === undefined) return unavailable("invalid_response");
    checks.push(instruction);
    return {
      revision: packet.revision,
      phase: packet.phase,
      durationMs: Math.round(performance.now() - started),
      status: "checked",
      model: response.model,
      inputTokens: response.usage.input,
      outputTokens: response.usage.output,
      checks,
    };
  } catch {
    return unavailable(
      timedOut
        ? "timeout"
        : receivedResponse && !transportFailed && !options.signal?.aborted
          ? "invalid_response"
          : "unavailable",
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortExternal);
    controller.signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
