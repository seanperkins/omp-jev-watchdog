import { expect, test } from "bun:test";
import { scoreReplayCase } from "../scripts/replay";
import type { WatchdogResult } from "../src/types";
import { REPLAY_CASES } from "./replay-fixtures";

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
