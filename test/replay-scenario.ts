import { EvidenceWindow } from "../src/packet";
import type { WatchdogPhase } from "../src/types";
import type { ReplayCase } from "./replay-fixtures";

export interface ScenarioCase extends ReplayCase {
  pair: string;
  partition: "development" | "holdout";
}

interface ScenarioDefinition {
  name: string;
  pair: string;
  partition: ScenarioCase["partition"];
  phase: WatchdogPhase;
  record: (window: EvidenceWindow) => void;
  expected: ReplayCase["expected"];
}

/** Synthetic data only. Real session evidence must use the host's native redactor. */
export function scenario(definition: ScenarioDefinition): ScenarioCase {
  const window = new EvidenceWindow(
    (text) => text,
    (args) => args,
  );
  definition.record(window);
  const packet = window.snapshot(definition.phase);
  if (!packet) throw new Error(`Empty replay scenario: ${definition.name}`);
  return {
    name: definition.name,
    pair: definition.pair,
    partition: definition.partition,
    packet,
    expected: definition.expected,
  };
}
