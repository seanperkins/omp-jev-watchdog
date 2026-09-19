import { createHash } from "node:crypto";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { WatchdogCheck, WatchdogCheckReason, WatchdogResult } from "../src/types";
import type { ReplayCase, ReplayCheckExpectation } from "../test/replay-fixtures";

type CheckKind = WatchdogCheck["kind"];
type ReplayVerdict = WatchdogCheck["verdict"] | "not_checked";
type ReplayExpectations = ReplayCase["expected"];

/** Historical reports predate typed check reasons; runtime checks do not. */
export interface ReplayCheck extends Omit<WatchdogCheck, "reason"> {
  reason?: WatchdogCheckReason;
}

export interface ReplayResult extends Omit<WatchdogResult, "checks"> {
  checks: ReplayCheck[];
}

export interface ReplayReportCase {
  name: string;
  expected: ReplayExpectations;
  fixtureHash?: string;
  passed: boolean;
  result: ReplayResult;
}

export interface ReplayReport {
  timestamp: string;
  rubricHash?: string;
  cases: ReplayReportCase[];
  passed: number;
  total: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ReplayCheckSummary {
  total: number;
  checked: number;
  clear: number;
  concern: number;
  insufficient: number;
  notChecked: number;
  matches: number;
  verdictMatches: number;
  falsePositives: number;
  missedConcerns: number;
  citationMismatches: number;
  reasons: Record<WatchdogCheckReason, number>;
  reasonUnavailable: number;
}

export interface ReplaySummary {
  byCheck: Record<CheckKind, ReplayCheckSummary>;
  models: string[];
  durationMs: {
    total: number;
    min: number | null;
    max: number | null;
    mean: number | null;
    median: number | null;
  };
  passed: number;
  total: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ReplayComparisonCheck {
  name: string;
  kind: CheckKind;
  comparable: boolean;
  outcome: "improved" | "regressed" | "unchanged" | "changed" | "incomparable";
  previousVerdict: ReplayVerdict;
  currentVerdict: ReplayVerdict;
  previousMatch: boolean;
  currentMatch: boolean;
}

export interface ReplayComparison {
  baseline: { rubricHash: string | null; models: string[] };
  current: { rubricHash: string | null; models: string[] };
  addedCases: string[];
  removedCases: string[];
  checks: ReplayComparisonCheck[];
  countDeltas: Record<CheckKind, ReplayCheckSummary>;
}

const CHECK_KINDS: CheckKind[] = ["verification", "instruction"];
const CHECK_REASONS: WatchdogCheckReason[] = [
  "no_conflict",
  "verification_contradiction",
  "instruction_conflict",
  "missing_evidence",
  "ambiguous_scope",
  "truncated_context",
];
const INVALID_REPORT = "Invalid replay report.";

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

function citationsMatch(expected: ReplayCheckExpectation, check: ReplayCheck): boolean {
  return (
    expected.verdict !== "concern" ||
    (check.instructionId === expected.instructionId &&
      expected.evidenceIds.some((ids) => sameIds(ids, check.evidenceIds)))
  );
}

function matches(
  expected: ReplayCheckExpectation | undefined,
  check: ReplayCheck | undefined,
): boolean {
  return (
    expected !== undefined &&
    check !== undefined &&
    check.verdict === expected.verdict &&
    citationsMatch(expected, check)
  );
}

function checkedResult(result: ReplayResult | undefined, kind: CheckKind): ReplayCheck | undefined {
  return result?.status === "checked"
    ? result.checks.find((check) => check.kind === kind)
    : undefined;
}

export function scoreReplayCase(
  fixture: Pick<ReplayCase, "expected">,
  result: ReplayResult,
): boolean {
  return (
    result.status === "checked" &&
    result.checks.length === Object.keys(fixture.expected).length &&
    new Set(result.checks.map((check) => check.kind)).size === result.checks.length &&
    CHECK_KINDS.every((kind) => {
      const expected = fixture.expected[kind];
      return expected === undefined || matches(expected, checkedResult(result, kind));
    })
  );
}

/** Object key order is immaterial; chronological packet arrays remain ordered. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  requireReport(serialized !== undefined);
  return serialized;
}

export function createReplayReport(
  runs: Array<{ fixture: ReplayCase; result: WatchdogResult }>,
  rubricHash: string,
): ReplayReport {
  return parseReplayReport({
    timestamp: new Date().toISOString(),
    rubricHash,
    cases: runs.map(({ fixture, result }) => ({
      name: fixture.name,
      expected: fixture.expected,
      fixtureHash: createHash("sha256")
        .update(canonicalJson({ packet: fixture.packet, expected: fixture.expected }))
        .digest("hex"),
      passed: false,
      result,
    })),
    passed: 0,
    total: runs.length,
    inputTokens: 0,
    outputTokens: 0,
  });
}

function emptyCheckSummary(): ReplayCheckSummary {
  return {
    total: 0,
    checked: 0,
    clear: 0,
    concern: 0,
    insufficient: 0,
    notChecked: 0,
    matches: 0,
    verdictMatches: 0,
    falsePositives: 0,
    missedConcerns: 0,
    citationMismatches: 0,
    reasons: {
      no_conflict: 0,
      verification_contradiction: 0,
      instruction_conflict: 0,
      missing_evidence: 0,
      ambiguous_scope: 0,
      truncated_context: 0,
    },
    reasonUnavailable: 0,
  };
}

export function summarizeReplayReport(report: ReplayReport): ReplaySummary {
  const byCheck = { verification: emptyCheckSummary(), instruction: emptyCheckSummary() };
  const durations: number[] = [];
  const models = new Set<string>();
  let passed = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let durationTotal = 0;
  for (const fixture of report.cases) {
    const { result } = fixture;
    if (scoreReplayCase(fixture, result)) passed++;
    inputTokens += result.inputTokens;
    outputTokens += result.outputTokens;
    durations.push(result.durationMs);
    durationTotal += result.durationMs;
    if (result.model !== undefined) models.add(result.model);
    for (const kind of CHECK_KINDS) {
      const expected = fixture.expected[kind];
      const check = checkedResult(result, kind);
      if (expected === undefined && check === undefined) continue;
      const counts = byCheck[kind];
      counts.total++;
      if (check === undefined) {
        counts.notChecked++;
        continue;
      }
      counts.checked++;
      counts[check.verdict]++;
      if (check.reason === undefined) counts.reasonUnavailable++;
      else counts.reasons[check.reason]++;
      if (matches(expected, check)) counts.matches++;
      if (expected?.verdict === check.verdict) counts.verdictMatches++;
      if (check.verdict === "concern" && expected !== undefined && expected.verdict !== "concern") {
        counts.falsePositives++;
      }
      if (check.verdict === "clear" && expected?.verdict === "concern") counts.missedConcerns++;
      if (
        check.verdict === "concern" &&
        expected?.verdict === "concern" &&
        !citationsMatch(expected, check)
      ) {
        counts.citationMismatches++;
      }
    }
  }
  durations.sort((left, right) => left - right);
  const midpoint = Math.floor(durations.length / 2);
  return {
    byCheck,
    models: [...models].sort(),
    durationMs: {
      total: durationTotal,
      min: durations[0] ?? null,
      max: durations[durations.length - 1] ?? null,
      mean: durations.length === 0 ? null : durationTotal / durations.length,
      median:
        durations.length === 0
          ? null
          : durations.length % 2 === 0
            ? (durations[midpoint - 1]! + durations[midpoint]!) / 2
            : durations[midpoint]!,
    },
    passed,
    total: report.cases.length,
    inputTokens,
    outputTokens,
  };
}

function expectedMeaning(expected: ReplayCheckExpectation | undefined): string | undefined {
  if (expected === undefined) return undefined;
  if (expected.verdict !== "concern") return expected.verdict;
  return canonicalJson({
    verdict: expected.verdict,
    instructionId: expected.instructionId,
    evidenceIds: [
      ...new Set(expected.evidenceIds.map((ids) => JSON.stringify([...ids].sort()))),
    ].sort(),
  });
}

function observedMeaning(check: ReplayCheck | undefined): string {
  if (check === undefined) return "not_checked";
  return canonicalJson({
    verdict: check.verdict,
    reason: check.reason,
    evidenceIds: [...check.evidenceIds].sort(),
    instructionId: check.instructionId,
  });
}

function subtractCounts(
  current: ReplayCheckSummary,
  baseline: ReplayCheckSummary,
): ReplayCheckSummary {
  return {
    total: current.total - baseline.total,
    checked: current.checked - baseline.checked,
    clear: current.clear - baseline.clear,
    concern: current.concern - baseline.concern,
    insufficient: current.insufficient - baseline.insufficient,
    notChecked: current.notChecked - baseline.notChecked,
    matches: current.matches - baseline.matches,
    verdictMatches: current.verdictMatches - baseline.verdictMatches,
    falsePositives: current.falsePositives - baseline.falsePositives,
    missedConcerns: current.missedConcerns - baseline.missedConcerns,
    citationMismatches: current.citationMismatches - baseline.citationMismatches,
    reasons: {
      no_conflict: current.reasons.no_conflict - baseline.reasons.no_conflict,
      verification_contradiction:
        current.reasons.verification_contradiction - baseline.reasons.verification_contradiction,
      instruction_conflict:
        current.reasons.instruction_conflict - baseline.reasons.instruction_conflict,
      missing_evidence: current.reasons.missing_evidence - baseline.reasons.missing_evidence,
      ambiguous_scope: current.reasons.ambiguous_scope - baseline.reasons.ambiguous_scope,
      truncated_context: current.reasons.truncated_context - baseline.reasons.truncated_context,
    },
    reasonUnavailable: current.reasonUnavailable - baseline.reasonUnavailable,
  };
}

export function compareReplayReports(
  current: ReplayReport,
  baseline: ReplayReport,
): ReplayComparison {
  const currentCases = new Map(current.cases.map((fixture) => [fixture.name, fixture]));
  const baselineCases = new Map(baseline.cases.map((fixture) => [fixture.name, fixture]));
  const currentSummary = summarizeReplayReport(current);
  const baselineSummary = summarizeReplayReport(baseline);
  const checks: ReplayComparisonCheck[] = [];
  for (const name of new Set([...currentCases.keys(), ...baselineCases.keys()])) {
    const previous = baselineCases.get(name);
    const next = currentCases.get(name);
    for (const kind of CHECK_KINDS) {
      const previousExpected = previous?.expected[kind];
      const currentExpected = next?.expected[kind];
      const previousCheck = checkedResult(previous?.result, kind);
      const currentCheck = checkedResult(next?.result, kind);
      if (!previousExpected && !currentExpected && !previousCheck && !currentCheck) continue;
      const comparable =
        previous?.fixtureHash !== undefined &&
        next?.fixtureHash !== undefined &&
        previous.fixtureHash === next.fixtureHash &&
        previousExpected !== undefined &&
        currentExpected !== undefined &&
        expectedMeaning(previousExpected) === expectedMeaning(currentExpected);
      const previousMatch = matches(previousExpected, previousCheck);
      const currentMatch = matches(currentExpected, currentCheck);
      let outcome: ReplayComparisonCheck["outcome"] = "incomparable";
      if (comparable) {
        if (previousMatch && !currentMatch) outcome = "regressed";
        else if (!previousMatch && currentMatch) outcome = "improved";
        else if (observedMeaning(previousCheck) === observedMeaning(currentCheck))
          outcome = "unchanged";
        else outcome = "changed";
      }
      checks.push({
        name,
        kind,
        comparable,
        outcome,
        previousVerdict: previousCheck?.verdict ?? "not_checked",
        currentVerdict: currentCheck?.verdict ?? "not_checked",
        previousMatch,
        currentMatch,
      });
    }
  }
  return {
    baseline: { rubricHash: baseline.rubricHash ?? null, models: baselineSummary.models },
    current: { rubricHash: current.rubricHash ?? null, models: currentSummary.models },
    addedCases: [...currentCases.keys()].filter((name) => !baselineCases.has(name)),
    removedCases: [...baselineCases.keys()].filter((name) => !currentCases.has(name)),
    checks,
    countDeltas: {
      verification: subtractCounts(
        currentSummary.byCheck.verification,
        baselineSummary.byCheck.verification,
      ),
      instruction: subtractCounts(
        currentSummary.byCheck.instruction,
        baselineSummary.byCheck.instruction,
      ),
    },
  };
}

function requireReport(condition: boolean): asserts condition {
  if (!condition) throw new Error(INVALID_REPORT);
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseHash(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  requireReport(typeof value === "string" && /^[a-fA-F0-9]{64}$/.test(value));
  return value.toLowerCase();
}

function parseIds(value: unknown): string[] {
  requireReport(Array.isArray(value) && value.every(nonemptyString));
  const ids: string[] = value;
  requireReport(new Set(ids).size === ids.length);
  return [...ids];
}

function parseExpected(value: unknown): ReplayExpectations {
  requireReport(isRecord(value));
  const keys = Object.keys(value);
  requireReport(
    keys.length > 0 && keys.every((key) => key === "verification" || key === "instruction"),
  );
  const expected: ReplayExpectations = {};
  for (const kind of CHECK_KINDS) {
    if (!Object.hasOwn(value, kind)) continue;
    const item = value[kind];
    requireReport(isRecord(item));
    if (item.verdict === "clear" || item.verdict === "insufficient") {
      requireReport(item.evidenceIds === undefined && item.instructionId === undefined);
      expected[kind] = { verdict: item.verdict };
      continue;
    }
    requireReport(
      item.verdict === "concern" && Array.isArray(item.evidenceIds) && item.evidenceIds.length > 0,
    );
    const evidenceIds = item.evidenceIds.map(parseIds);
    requireReport(evidenceIds.every((ids) => ids.length === (kind === "verification" ? 2 : 1)));
    requireReport(
      kind === "instruction"
        ? nonemptyString(item.instructionId)
        : item.instructionId === undefined,
    );
    expected[kind] = {
      verdict: "concern",
      evidenceIds,
      ...(kind === "instruction" ? { instructionId: item.instructionId as string } : {}),
    };
  }
  return expected;
}

function parseCheck(value: unknown): ReplayCheck {
  requireReport(isRecord(value));
  const { kind, verdict, confidence, summary, reason, instructionId } = value;
  requireReport(kind === "verification" || kind === "instruction");
  requireReport(verdict === "clear" || verdict === "concern" || verdict === "insufficient");
  requireReport(nonnegative(confidence) && confidence <= 1 && typeof summary === "string");
  requireReport(reason === undefined || CHECK_REASONS.some((candidate) => candidate === reason));
  requireReport(instructionId === undefined || nonemptyString(instructionId));
  const evidenceIds = parseIds(value.evidenceIds);
  if (verdict === "concern") {
    requireReport(evidenceIds.length === (kind === "verification" ? 2 : 1));
    requireReport(
      kind === "instruction" ? instructionId !== undefined : instructionId === undefined,
    );
  } else {
    requireReport(evidenceIds.length === 0 && instructionId === undefined);
  }
  if (reason !== undefined) {
    requireReport(
      verdict === "clear"
        ? reason === "no_conflict"
        : verdict === "concern"
          ? reason ===
            (kind === "verification" ? "verification_contradiction" : "instruction_conflict")
          : reason === "missing_evidence" ||
            reason === "ambiguous_scope" ||
            reason === "truncated_context",
    );
  }
  return {
    kind,
    verdict,
    confidence,
    summary,
    evidenceIds,
    ...(reason === undefined ? {} : { reason: reason as WatchdogCheckReason }),
    ...(instructionId === undefined ? {} : { instructionId }),
  };
}

function parseResult(value: unknown): ReplayResult {
  requireReport(isRecord(value));
  const { revision, phase, status, durationMs, model, inputTokens, outputTokens, reason } = value;
  requireReport(nonnegative(revision) && Number.isSafeInteger(revision));
  requireReport(phase === "working" || phase === "complete");
  requireReport(status === "checked" || status === "not_checked");
  requireReport(nonnegative(durationMs) && nonnegative(inputTokens) && nonnegative(outputTokens));
  requireReport(model === undefined || nonemptyString(model));
  requireReport(
    reason === undefined ||
      reason === "timeout" ||
      reason === "unavailable" ||
      reason === "invalid_response",
  );
  requireReport(Array.isArray(value.checks));
  const checks = value.checks.map(parseCheck);
  requireReport(new Set(checks.map((check) => check.kind)).size === checks.length);
  requireReport(
    status === "checked" ? checks.length > 0 && reason === undefined : checks.length === 0,
  );
  return {
    revision,
    phase,
    status,
    durationMs,
    inputTokens,
    outputTokens,
    checks,
    ...(model === undefined ? {} : { model }),
    ...(reason === undefined ? {} : { reason }),
  };
}

/** Parse persisted data without trusting stored successes or inventing historical provenance. */
export function parseReplayReport(value: unknown): ReplayReport {
  try {
    requireReport(isRecord(value));
    requireReport(nonemptyString(value.timestamp) && Number.isFinite(Date.parse(value.timestamp)));
    requireReport(Array.isArray(value.cases));
    requireReport(nonnegative(value.passed) && Number.isSafeInteger(value.passed));
    requireReport(nonnegative(value.total) && Number.isSafeInteger(value.total));
    requireReport(nonnegative(value.inputTokens) && nonnegative(value.outputTokens));
    const rubricHash = parseHash(value.rubricHash);
    const names = new Set<string>();
    const cases: ReplayReportCase[] = value.cases.map((item: unknown) => {
      requireReport(
        isRecord(item) && nonemptyString(item.name) && typeof item.passed === "boolean",
      );
      requireReport(!names.has(item.name));
      names.add(item.name);
      const expected = parseExpected(item.expected);
      const result = parseResult(item.result);
      const fixtureHash = parseHash(item.fixtureHash);
      return {
        name: item.name,
        expected,
        result,
        passed: scoreReplayCase({ expected }, result),
        ...(fixtureHash === undefined ? {} : { fixtureHash }),
      };
    });
    const report: ReplayReport = {
      timestamp: value.timestamp,
      cases,
      passed: cases.filter((fixture) => fixture.passed).length,
      total: cases.length,
      inputTokens: cases.reduce((sum, fixture) => sum + fixture.result.inputTokens, 0),
      outputTokens: cases.reduce((sum, fixture) => sum + fixture.result.outputTokens, 0),
      ...(rubricHash === undefined ? {} : { rubricHash }),
    };
    requireReport(nonnegative(report.inputTokens) && nonnegative(report.outputTokens));
    return report;
  } catch {
    throw new Error(INVALID_REPORT);
  }
}
