import type { WatchdogPacket, WatchdogRecord, WatchdogResult } from "./types";

export interface WatchdogStats {
  requests: number;
  checked: number;
  notChecked: number;
  concerns: number;
  inputTokens: number;
  outputTokens: number;
}

const EMPTY_STATS: Readonly<WatchdogStats> = {
  requests: 0,
  checked: 0,
  notChecked: 0,
  concerns: 0,
  inputTokens: 0,
  outputTokens: 0,
};

interface ShadowWatchdogOptions {
  evaluate(packet: WatchdogPacket, signal: AbortSignal): Promise<WatchdogResult>;
  record(record: WatchdogRecord): void;
  changed?(): void;
}

interface PendingReview {
  packet: WatchdogPacket;
  epoch: number;
}

export class ShadowWatchdog {
  readonly #options: ShadowWatchdogOptions;
  #enabled = true;
  #epoch = 0;
  #pending: PendingReview | undefined;
  #running: Promise<void> | undefined;
  #abort: AbortController | undefined;
  #lastKey: string | undefined;
  #latest: WatchdogRecord | undefined;
  #stats: WatchdogStats = { ...EMPTY_STATS };

  constructor(options: ShadowWatchdogOptions) {
    this.#options = options;
  }

  get enabled(): boolean {
    return this.#enabled;
  }
  get busy(): boolean {
    return this.#running !== undefined;
  }
  get latest(): WatchdogRecord | undefined {
    return this.#latest;
  }
  get stats(): WatchdogStats {
    return { ...this.#stats };
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    this.#epoch++;
    this.#pending = undefined;
    this.#lastKey = undefined;
    this.#abort?.abort();
    this.#options.changed?.();
  }

  reset(): void {
    this.#epoch++;
    this.#abort?.abort();
    this.#pending = undefined;
    this.#lastKey = undefined;
    this.#latest = undefined;
    this.#stats = { ...EMPTY_STATS };
    this.#options.changed?.();
  }

  submit(packet: WatchdogPacket): void {
    if (!this.#enabled) return;
    const key = `${packet.revision}:${packet.phase}`;
    if (key === this.#lastKey) return;
    this.#lastKey = key;
    this.#pending = { packet, epoch: this.#epoch };
    if (packet.phase === "complete") this.#abort?.abort();
    this.#start();
    this.#options.changed?.();
  }

  async flush(): Promise<void> {
    while (this.#running) await this.#running;
  }

  #start(): void {
    if (this.#running || !this.#pending || !this.#enabled) return;
    this.#running = this.#drain().finally(() => {
      this.#running = undefined;
      this.#start();
      this.#options.changed?.();
    });
  }

  async #drain(): Promise<void> {
    while (this.#pending && this.#enabled) {
      const { packet, epoch } = this.#pending;
      this.#pending = undefined;
      const controller = new AbortController();
      this.#abort = controller;
      const start = performance.now();
      let result: WatchdogResult;
      try {
        result = await this.#options.evaluate(packet, controller.signal);
      } catch {
        result = {
          revision: packet.revision,
          phase: packet.phase,
          status: "not_checked",
          durationMs: Math.round(performance.now() - start),
          inputTokens: 0,
          outputTokens: 0,
          checks: [],
          reason: "unavailable",
        };
      } finally {
        if (this.#abort === controller) this.#abort = undefined;
      }
      if (epoch !== this.#epoch || !this.#enabled) continue;
      this.#stats.requests++;
      this.#stats.inputTokens += result.inputTokens;
      this.#stats.outputTokens += result.outputTokens;
      // A newer packet includes the changed evidence; an older result cannot warn about it.
      if (this.#pending) continue;
      if (result.status === "checked") this.#stats.checked++;
      else this.#stats.notChecked++;
      this.#stats.concerns += result.checks.filter((check) => check.verdict === "concern").length;
      const record: WatchdogRecord = { ...result, timestamp: new Date().toISOString(), packet };
      this.#latest = record;
      this.#options.record(record);
      this.#options.changed?.();
    }
  }
}
