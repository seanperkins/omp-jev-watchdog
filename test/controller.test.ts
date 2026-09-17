import { describe, expect, test } from "bun:test";
import { ShadowWatchdog } from "../src/controller";
import type { WatchdogPacket, WatchdogRecord, WatchdogResult } from "../src/types";

const packet = (revision: number, phase: "working" | "complete" = "working"): WatchdogPacket => ({
  revision,
  phase,
  instructions: [{ id: "u1", kind: "user", text: "Preserve the configuration." }],
  evidence: [{ id: `e${revision}`, kind: "tool_result", text: "Read completed." }],
  omitted: false,
});
const result = (input: WatchdogPacket): WatchdogResult => ({
  revision: input.revision,
  phase: input.phase,
  status: "checked",
  durationMs: 1,
  model: "fixture",
  inputTokens: 10,
  outputTokens: 1,
  checks: [],
});

describe("shadow watchdog lifecycle", () => {
  test("coalesces updates and never publishes a superseded finding", async () => {
    const first = Promise.withResolvers<WatchdogResult>();
    const entered = Promise.withResolvers<void>();
    const evaluated: number[] = [];
    const records: WatchdogRecord[] = [];
    const controller = new ShadowWatchdog({
      evaluate: async (input) => {
        evaluated.push(input.revision);
        if (input.revision === 1) {
          entered.resolve();
          return first.promise;
        }
        return result(input);
      },
      record: (record) => records.push(record),
    });
    controller.submit(packet(1));
    await entered.promise;
    controller.submit(packet(2));
    controller.submit(packet(3, "complete"));
    first.resolve(result(packet(1)));
    await controller.flush();
    expect(evaluated).toEqual([1, 3]);
    expect(records.map((record) => record.revision)).toEqual([3]);
    expect(controller.stats.inputTokens).toBe(20);
  });

  test("turning off cancels work and prevents late records", async () => {
    const first = Promise.withResolvers<WatchdogResult>();
    const records: WatchdogRecord[] = [];
    let signal: AbortSignal | undefined;
    const controller = new ShadowWatchdog({
      evaluate: async (input, requestSignal) => {
        signal = requestSignal;
        return first.promise;
      },
      record: (record) => records.push(record),
    });
    controller.submit(packet(1));
    controller.setEnabled(false);
    expect(signal?.aborted).toBe(true);
    first.resolve(result(packet(1)));
    await controller.flush();
    expect(records).toEqual([]);
    controller.submit(packet(2));
    expect(controller.stats.requests).toBe(0);
  });

  test("completion is checked once even after a working check at the same revision", async () => {
    const records: WatchdogRecord[] = [];
    const controller = new ShadowWatchdog({
      evaluate: async (input) => result(input),
      record: (record) => records.push(record),
    });
    controller.submit(packet(1));
    await controller.flush();
    controller.submit(packet(1, "complete"));
    controller.submit(packet(1, "complete"));
    await controller.flush();
    expect(records.map((record) => record.phase)).toEqual(["working", "complete"]);
  });

  test("reset isolates the next session from pending results", async () => {
    const first = Promise.withResolvers<WatchdogResult>();
    const records: WatchdogRecord[] = [];
    let calls = 0;
    const controller = new ShadowWatchdog({
      evaluate: async (input) => (++calls === 1 ? first.promise : result(input)),
      record: (record) => records.push(record),
    });
    controller.submit(packet(1));
    controller.reset();
    controller.submit(packet(1, "complete"));
    first.resolve(result(packet(1)));
    await controller.flush();
    expect(records.map((record) => record.phase)).toEqual(["complete"]);
  });

  test("does not lose a completion arriving as the previous check settles", async () => {
    const records: WatchdogRecord[] = [];
    const controller = new ShadowWatchdog({
      evaluate: async (input) => result(input),
      record: (record) => {
        records.push(record);
        if (record.revision === 1) queueMicrotask(() => controller.submit(packet(2, "complete")));
      },
    });
    controller.submit(packet(1));
    await controller.flush();
    expect(records.map((record) => record.revision)).toEqual([1, 2]);
  });

  test("completion cancels outdated work instead of waiting through two deadlines", async () => {
    const first = Promise.withResolvers<WatchdogResult>();
    const records: WatchdogRecord[] = [];
    let workingSignal: AbortSignal | undefined;
    const controller = new ShadowWatchdog({
      evaluate: async (input, signal) => {
        if (input.phase === "complete") return result(input);
        workingSignal = signal;
        signal.addEventListener("abort", () => first.resolve(result(input)), { once: true });
        return first.promise;
      },
      record: (record) => records.push(record),
    });
    controller.submit(packet(1));
    controller.submit(packet(2, "complete"));
    expect(workingSignal?.aborted).toBe(true);
    await controller.flush();
    expect(records.map((record) => record.phase)).toEqual(["complete"]);
  });
});
