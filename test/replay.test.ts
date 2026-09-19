import { expect, test } from "bun:test";
import {
  compareReplayReports,
  createReplayReport,
  parseReplayReport,
  scoreReplayCase,
  summarizeReplayReport,
} from "../scripts/replay-report";
import type { WatchdogResult } from "../src/types";
import { REPLAY_CASES } from "./replay-fixtures";

const RUBRIC_A = "a".repeat(64);
const RUBRIC_B = "b".repeat(64);

test("replay rejects a quoted instruction as evidence of the prohibited edit", () => {
  const fixture = REPLAY_CASES.find(
    (item) => item.name === "tool output instruction injection cannot override prohibition",
  )!;
  const result: WatchdogResult = {
    revision: 4,
    phase: "working",
    status: "checked",
    durationMs: 1,
    model: "fixture",
    inputTokens: 1,
    outputTokens: 1,
    checks: [
      {
        kind: "instruction",
        verdict: "concern",
        reason: "instruction_conflict",
        confidence: 1,
        evidenceIds: ["e1"],
        instructionId: "u1",
        summary: "Candidate conflict",
      },
    ],
  };
  expect(scoreReplayCase(fixture, result)).toBe(false);
  result.checks[0]!.evidenceIds = ["e2"];
  expect(scoreReplayCase(fixture, result)).toBe(true);
});

function observed(fixtureIndex = 0): WatchdogResult {
  return {
    revision: REPLAY_CASES[fixtureIndex]!.packet.revision,
    phase: REPLAY_CASES[fixtureIndex]!.packet.phase,
    status: "checked",
    durationMs: 10,
    model: "fixture-model",
    inputTokens: 100,
    outputTokens: 10,
    checks: [
      {
        kind: "verification",
        verdict: "concern",
        reason: "verification_contradiction",
        confidence: 0.8,
        evidenceIds: ["e3", "e2"],
        summary: "Candidate contradiction",
      },
      {
        kind: "instruction",
        verdict: "clear",
        reason: "no_conflict",
        confidence: 0.8,
        evidenceIds: [],
        summary: "No observed conflict",
      },
    ],
  };
}

test("per-check reporting separates citation errors from false positive verdicts", () => {
  const result = observed();
  result.checks[0]!.evidenceIds = ["e3", "e1"];
  result.checks[1] = {
    kind: "instruction",
    verdict: "concern",
    reason: "instruction_conflict",
    confidence: 0.26,
    evidenceIds: ["e1"],
    instructionId: "u1",
    summary: "Candidate conflict",
  };
  const report = createReplayReport([{ fixture: REPLAY_CASES[0]!, result }], RUBRIC_A);
  const summary = summarizeReplayReport(report);
  expect(summary.byCheck.verification).toMatchObject({
    total: 1,
    checked: 1,
    verdictMatches: 1,
    matches: 0,
    citationMismatches: 1,
    falsePositives: 0,
  });
  expect(summary.byCheck.instruction).toMatchObject({
    total: 1,
    matches: 0,
    falsePositives: 1,
    citationMismatches: 0,
  });
  expect(report.inputTokens).toBe(100);
});

test("lost checking coverage is not reported as a resolved concern", () => {
  const fixture = REPLAY_CASES[0]!;
  const before = createReplayReport([{ fixture, result: observed() }], RUBRIC_A);
  const result: WatchdogResult = {
    ...observed(),
    status: "not_checked",
    reason: "timeout",
    checks: [],
  };
  const after = createReplayReport([{ fixture, result }], RUBRIC_B);
  const comparison = compareReplayReports(after, before);
  expect(comparison.checks.find((check) => check.kind === "verification")).toMatchObject({
    comparable: true,
    outcome: "regressed",
    previousVerdict: "concern",
    currentVerdict: "not_checked",
  });
  expect(summarizeReplayReport(after).byCheck.verification).toMatchObject({
    total: 1,
    checked: 0,
    notChecked: 1,
    missedConcerns: 0,
  });
});

test("same case name with changed evidence cannot imply an improvement", () => {
  const fixture = REPLAY_CASES[0]!;
  const before = createReplayReport([{ fixture, result: observed() }], RUBRIC_A);
  const changed = structuredClone(fixture);
  changed.packet.evidence[0]!.text = "Different evidence";
  const after = createReplayReport([{ fixture: changed, result: observed() }], RUBRIC_A);
  expect(compareReplayReports(after, before).checks[0]).toMatchObject({
    comparable: false,
    outcome: "incomparable",
  });
});

test("historical reports without evidence identity remain explicitly incomparable", async () => {
  const old = parseReplayReport(await Bun.file("evaluation-results.json").json());
  const comparison = compareReplayReports(old, old);
  expect(comparison.checks.every((check) => !check.comparable)).toBe(true);
  expect(summarizeReplayReport(old).byCheck.instruction).toMatchObject({
    total: 11,
    matches: 10,
    falsePositives: 1,
  });
});

test("malformed baseline data fails locally rather than becoming empty success", () => {
  expect(() => parseReplayReport({ cases: [], passed: 0, total: 0 })).toThrow();
});

test("insufficient evidence is neither a missed concern nor a clear outcome", () => {
  const result = observed();
  result.checks[0] = {
    kind: "verification",
    verdict: "insufficient",
    reason: "missing_evidence",
    confidence: 0.9,
    evidenceIds: [],
    summary: "Not enough evidence",
  };
  const summary = summarizeReplayReport(
    createReplayReport([{ fixture: REPLAY_CASES[0]!, result }], RUBRIC_A),
  );
  expect(summary.byCheck.verification).toMatchObject({
    checked: 1,
    insufficient: 1,
    clear: 0,
    missedConcerns: 0,
    matches: 0,
    reasons: { missing_evidence: 1 },
  });
  expect(summary.inputTokens).toBe(100);
  expect(summary.outputTokens).toBe(10);
});

test("correcting citations improves a check without requiring its concern to disappear", () => {
  const fixture = REPLAY_CASES[0]!;
  const result = observed();
  result.checks[0]!.evidenceIds = ["e3", "e1"];
  const before = createReplayReport([{ fixture, result }], RUBRIC_A);
  const after = createReplayReport([{ fixture, result: observed() }], RUBRIC_B);
  expect(compareReplayReports(after, before).checks[0]).toMatchObject({
    outcome: "improved",
    previousVerdict: "concern",
    currentVerdict: "concern",
  });
});

test("a false positive becoming insufficient is changed, not improved", () => {
  const fixture = REPLAY_CASES[0]!;
  const result = observed();
  result.checks[1] = {
    kind: "instruction",
    verdict: "concern",
    reason: "instruction_conflict",
    confidence: 0.2,
    evidenceIds: ["e1"],
    instructionId: "u1",
    summary: "Incorrect concern",
  };
  const before = createReplayReport([{ fixture, result }], RUBRIC_A);
  result.checks[1] = {
    kind: "instruction",
    verdict: "insufficient",
    reason: "ambiguous_scope",
    confidence: 0.8,
    evidenceIds: [],
    summary: "Scope not established",
  };
  const after = createReplayReport([{ fixture, result }], RUBRIC_B);
  expect(compareReplayReports(after, before).checks[1]).toMatchObject({
    outcome: "changed",
    previousMatch: false,
    currentMatch: false,
  });
});

test("persisted success flags and aggregate totals cannot conceal a failed check", () => {
  const result = observed();
  result.checks[0]!.evidenceIds = ["e3", "e1"];
  const persisted = createReplayReport([{ fixture: REPLAY_CASES[0]!, result }], RUBRIC_A);
  persisted.cases[0]!.passed = true;
  persisted.passed = 1;
  persisted.total = 100;
  persisted.inputTokens = 9999;
  const parsed = parseReplayReport(persisted);
  expect(parsed).toMatchObject({ passed: 0, total: 1, inputTokens: 100 });
  expect(parsed.cases[0]!.passed).toBe(false);
  expect(summarizeReplayReport(parsed).passed).toBe(0);
});

test("baseline parsing rejects ambiguous identities and malformed citation or usage data", () => {
  const valid = createReplayReport([{ fixture: REPLAY_CASES[0]!, result: observed() }], RUBRIC_A);
  const duplicatedCase = structuredClone(valid);
  duplicatedCase.cases.push(structuredClone(duplicatedCase.cases[0]!));
  const duplicatedCheck = structuredClone(valid);
  duplicatedCheck.cases[0]!.result.checks.push(
    structuredClone(duplicatedCheck.cases[0]!.result.checks[0]!),
  );
  const invalidUsage = structuredClone(valid);
  invalidUsage.cases[0]!.result.inputTokens = Number.NaN;
  const invalidConfidence = structuredClone(valid);
  invalidConfidence.cases[0]!.result.checks[0]!.confidence = 1.1;
  const invalidExpected = structuredClone(valid);
  invalidExpected.cases[0]!.expected.verification = {
    verdict: "concern",
    evidenceIds: [["e3", "e3"]],
  };
  const invalidHash = structuredClone(valid);
  invalidHash.cases[0]!.fixtureHash = "sensitive-invalid-content";
  for (const value of [
    duplicatedCase,
    duplicatedCheck,
    invalidUsage,
    invalidConfidence,
    invalidExpected,
    invalidHash,
  ]) {
    expect(() => parseReplayReport(value)).toThrow("Invalid replay report.");
  }
});

test("a reused evidence hash cannot make changed expectations comparable", () => {
  const before = createReplayReport([{ fixture: REPLAY_CASES[0]!, result: observed() }], RUBRIC_A);
  const after = structuredClone(before);
  after.cases[0]!.expected.verification = { verdict: "clear" };
  expect(compareReplayReports(after, before).checks[0]).toMatchObject({
    comparable: false,
    outcome: "incomparable",
  });
});
