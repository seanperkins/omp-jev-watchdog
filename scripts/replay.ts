import { $ } from "bun";
import { evaluateWatchdog } from "../src/evaluate";
import type { WatchdogResult } from "../src/types";
import { REPLAY_CASES, type ReplayCase } from "../test/replay-fixtures";

export function scoreReplayCase(fixture: ReplayCase, result: WatchdogResult): boolean {
  if (
    result.status !== "checked" ||
    result.checks.length !== Object.keys(fixture.expected).length
  ) {
    return false;
  }
  return Object.entries(fixture.expected).every(([kind, expected]) => {
    const check = result.checks.find((candidate) => candidate.kind === kind);
    if (!check || check.verdict !== expected.verdict) return false;
    if (expected.verdict !== "concern") return true;
    return (
      check.instructionId === expected.instructionId &&
      expected.evidenceIds.some(
        (ids) =>
          ids.length === check.evidenceIds.length &&
          ids.every((id) => check.evidenceIds.includes(id)),
      )
    );
  });
}

async function main(): Promise<void> {
  const credentials = await $`omp token typesafe --raw`.quiet().nothrow();
  if (credentials.exitCode !== 0 || !credentials.text().trim()) {
    throw new Error(
      "TypeSafe credential unavailable. Use /login typesafe; never paste the key into a transcript.",
    );
  }
  const apiKey = credentials.text().trim();
  const cases = [];
  for (const fixture of REPLAY_CASES) {
    const result = await evaluateWatchdog(fixture.packet, { apiKey });
    const passed = scoreReplayCase(fixture, result);
    cases.push({ name: fixture.name, expected: fixture.expected, passed, result });
  }
  const report = {
    timestamp: new Date().toISOString(),
    cases,
    passed: cases.filter((fixture) => fixture.passed).length,
    total: cases.length,
    inputTokens: cases.reduce((sum, fixture) => sum + fixture.result.inputTokens, 0),
    outputTokens: cases.reduce((sum, fixture) => sum + fixture.result.outputTokens, 0),
  };
  const outputIndex = Bun.argv.indexOf("--output");
  if (outputIndex !== -1) {
    const destination = Bun.argv[outputIndex + 1];
    if (!destination) throw new Error("--output requires a file path");
    await Bun.write(destination, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.passed !== report.total) process.exitCode = 1;
}

if (import.meta.main) await main();
