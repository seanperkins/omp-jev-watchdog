import { CHRONOLOGY_DEVELOPMENT_CASES } from "./replay-chronology-development";
import { CHRONOLOGY_HOLDOUT_CASES } from "./replay-chronology-holdout";
import { REPLAY_CASES, type ReplayCase } from "./replay-fixtures";
import type { ScenarioCase } from "./replay-scenario";
import { SCOPE_CASES } from "./replay-scope-fixtures";
import { VERIFICATION_CASES } from "./replay-verification-fixtures";

export const SCENARIO_CASES: ScenarioCase[] = [...SCOPE_CASES, ...VERIFICATION_CASES];

export type ReplaySuite =
  | "original"
  | "development"
  | "holdout"
  | "chronology-development"
  | "chronology-holdout"
  | "all";

export const REPLAY_SUITES: Record<ReplaySuite, ReplayCase[]> = {
  original: REPLAY_CASES,
  development: [
    ...REPLAY_CASES,
    ...SCENARIO_CASES.filter((fixture) => fixture.partition === "development"),
  ],
  holdout: SCENARIO_CASES.filter((fixture) => fixture.partition === "holdout"),
  "chronology-development": CHRONOLOGY_DEVELOPMENT_CASES,
  "chronology-holdout": CHRONOLOGY_HOLDOUT_CASES,
  all: [
    ...REPLAY_CASES,
    ...SCENARIO_CASES,
    ...CHRONOLOGY_DEVELOPMENT_CASES,
    ...CHRONOLOGY_HOLDOUT_CASES,
  ],
};
