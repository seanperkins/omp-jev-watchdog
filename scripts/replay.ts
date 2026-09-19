import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";
import { evaluateWatchdog, WATCHDOG_RUBRIC_HASH } from "../src/evaluate";
import type { WatchdogResult } from "../src/types";
import { REPLAY_CASES, type ReplayCase } from "../test/replay-fixtures";
import {
  compareReplayReports,
  createReplayReport,
  parseReplayReport,
  type ReplayReport,
  summarizeReplayReport,
} from "./replay-report";

interface ReplayOptions {
  input?: string;
  baseline?: string;
  output?: string;
}

class ReplayCliError extends Error {}

function parseOptions(args: string[]): ReplayOptions {
  const options: ReplayOptions = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (flag !== "--input" && flag !== "--baseline" && flag !== "--output") {
      throw new ReplayCliError("Use --input FILE, --baseline FILE, and/or --output FILE.");
    }
    const key = flag === "--input" ? "input" : flag === "--baseline" ? "baseline" : "output";
    const path = args[index + 1];
    if (path === undefined || path.trim().length === 0 || path.startsWith("-")) {
      throw new ReplayCliError("Each replay option requires a file path.");
    }
    if (options[key] !== undefined) throw new ReplayCliError("Replay options cannot be repeated.");
    options[key] = path;
  }
  return options;
}

async function readReport(path: string): Promise<ReplayReport> {
  try {
    return parseReplayReport(await Bun.file(path).json());
  } catch {
    throw new ReplayCliError("Cannot read a valid replay report from the supplied file.");
  }
}

async function validateOutput(path: string): Promise<void> {
  const historicalPath = fileURLToPath(new URL("../evaluation-results.json", import.meta.url));
  if (resolve(path) === historicalPath) {
    throw new ReplayCliError("The committed historical report cannot be overwritten.");
  }
  try {
    const destination = await stat(path);
    if (!destination.isFile()) throw new ReplayCliError("Replay output must name a file.");
    const historical = await stat(historicalPath);
    if (destination.dev === historical.dev && destination.ino === historical.ino) {
      throw new ReplayCliError("The committed historical report cannot be overwritten.");
    }
  } catch (error) {
    if (error instanceof ReplayCliError) throw error;
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return;
    throw new ReplayCliError("Cannot use the supplied replay output destination.");
  }
}

async function main(): Promise<void> {
  const options = parseOptions(Bun.argv.slice(2));
  // All local inputs are validated before credential resolution or a remote request.
  const input = options.input === undefined ? undefined : await readReport(options.input);
  const baseline = options.baseline === undefined ? undefined : await readReport(options.baseline);
  if (options.output !== undefined) await validateOutput(options.output);

  let report: ReplayReport;
  if (input !== undefined) {
    report = input;
  } else {
    const credentials = await $`omp token typesafe --raw`.quiet().nothrow();
    if (credentials.exitCode !== 0 || !credentials.text().trim()) {
      throw new ReplayCliError(
        "TypeSafe credential unavailable. Use /login typesafe; never paste the key into a transcript.",
      );
    }
    const apiKey = credentials.text().trim();
    const runs: Array<{ fixture: ReplayCase; result: WatchdogResult }> = [];
    for (const fixture of REPLAY_CASES) {
      runs.push({ fixture, result: await evaluateWatchdog(fixture.packet, { apiKey }) });
    }
    report = createReplayReport(runs, WATCHDOG_RUBRIC_HASH);
  }

  const summary = summarizeReplayReport(report);
  const output = JSON.stringify(
    {
      ...report,
      summary,
      ...(baseline === undefined ? {} : { comparison: compareReplayReports(report, baseline) }),
    },
    null,
    2,
  );
  if (options.output !== undefined) await Bun.write(options.output, `${output}\n`);
  console.log(output);
  if (summary.passed !== summary.total) process.exitCode = 1;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof ReplayCliError ? error.message : "Replay failed.");
    process.exitCode = 1;
  }
}
