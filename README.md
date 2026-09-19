# OMP Jev Watchdog

An experimental, shadow-only watchdog for [Oh My Pi](https://github.com/can1357/oh-my-pi), using TypeSafe's Jev through OMP's native judgment client.

It records candidate verification contradictions and explicit user-instruction conflicts. It **does not inject advice, interrupt the agent, invoke a reviewer, or replace the full advisor**. Existing advisor and classifier settings stay unchanged.

**Trial status:** the committed live replay matched 10 of 11 expected outcomes, including one instruction-check false positive. Keep this in shadow mode; it is not a validated safety gate or general code reviewer.

## What it checks

| Check                 | Evidence                                                             | When                          |
| --------------------- | -------------------------------------------------------------------- | ----------------------------- |
| Instruction adherence | Observed tool calls/results versus recent explicit user instructions | During work and at completion |
| Verification honesty  | The final assistant claim versus actual tool results                 | At completion only            |

A failed command followed by “the command passed” can produce a candidate contradiction. A relevant successful rerun supersedes an earlier failure. An honest draft, missing test result, or unfinished task is not automatically a violation.

Only recent user messages establish instructions for these checks. This is not comprehensive enforcement of system prompts, `AGENTS.md`, or every requirement in a long conversation. Tool output and quoted instructions are treated as evidence, not authority.

## Install

Requirements: [Bun](https://bun.sh) 1.3.14 or newer, OMP on your `PATH`, and a TypeSafe credential configured through `/login typesafe` inside OMP. The extension is tested against OMP **18.2.4**; compatibility with other versions is not guaranteed.

1. Clone the source and install dependencies:

   ```sh
   git clone https://github.com/seanperkins/omp-jev-watchdog.git
   cd omp-jev-watchdog
   bun install --frozen-lockfile
   ```

2. Link the extension into OMP:

   ```sh
   omp plugin install .
   ```

   This is a user-wide local link. Keep the checkout at its installed location.

3. Start a fresh OMP session in the project you want to work on. Check availability:

   ```text
   /jev-watchdog status
   ```

   Shadow mode is enabled by default. If it reports unavailable, confirm the TypeSafe login and restart the session. The watchdog also refuses remote review when OMP's native secret redactor cannot initialize.

4. After the agent completes a prompt, inspect its latest check:

   ```text
   /jev-watchdog latest
   ```

## Commands and results

| Command                                   | Behavior                                                             |
| ----------------------------------------- | -------------------------------------------------------------------- |
| `/jev-watchdog` or `/jev-watchdog status` | Mode, availability, current-prompt counts, token usage, and deadline |
| `/jev-watchdog latest`                    | Most recent check for this prompt, with typed reasons and evidence IDs |
| `/jev-watchdog off`                       | Disable checks and cancel pending work for this session              |
| `/jev-watchdog shadow`                    | Re-enable shadow checks for this session                             |

The off/shadow choice is saved in the session branch. A new session starts in shadow mode. Counts and the in-memory latest result reset when a new prompt begins or session context is reinitialized; they are not all-time totals. Earlier review records remain in the session file.

| Result         | Meaning                                                                            |
| -------------- | ---------------------------------------------------------------------------------- |
| `clear`        | No material conflict identified in the supplied evidence; not proof of correctness |
| `concern`      | A candidate conflict with selected evidence and a claim or instruction reference   |
| `insufficient` | Not enough usable evidence to decide                                               |
| `not_checked`  | No valid judgment: timeout, unavailability, or an invalid response                 |

**Confidence is an uncalibrated model signal, not a probability that the finding is correct.** Inspect the cited evidence before acting. `latest` reports reasons, summaries, and IDs; redacted evidence packets are stored as `jev-watchdog-review` custom entries in OMP's session JSONL. Those entries are not messages to the main model. Session mode entries use `jev-watchdog-mode`.

Each checked result includes a closed-choice reason:

| Reason | Verdict | Meaning |
| ------ | ------- | ------- |
| `no_conflict` | `clear` | No material conflict identified in the supplied evidence |
| `verification_contradiction` | `concern` | A final claim conflicts with a directly relevant tool result |
| `instruction_conflict` | `concern` | An observed action conflicts with an applicable explicit user instruction |
| `missing_evidence` | `insufficient` | Required evidence is absent |
| `ambiguous_scope` | `insufficient` | Relevance, applicability, scope, or chronology cannot be established |
| `truncated_context` | `insufficient` | Omitted or truncated context prevents a decision |

Reasons explain the existing checks; they are not new detectors or proof of a defect. They are selected in the same bounded request, not a follow-up call. Invalid reason/verdict combinations become `not_checked` with `invalid_response`. A selected truncated citation still downgrades a concern to `insufficient`/`truncated_context`, without retaining candidate citations.

Each evaluation has a **1,000 ms total deadline**, with no HTTP retry or LLM fallback. Newer evidence can supersede an in-flight result. Completion checks take priority over working checks; shutdown drains outstanding bounded work so the final record can be saved.

## Privacy and context limits

**This is not local-only inference.** Bounded, redacted conversation evidence is sent to TypeSafe's remote API. Review [TypeSafe's privacy policy](https://typesafe.ai/privacy) before using it with sensitive work.

- Collected inputs: recent user text, assistant text, tool arguments, and textual tool results. File contents can be included when a tool returns them; the watchdog does not independently scan the repository.
- OMP's native redactor runs before evidence retention and submission. Tool argument values are redacted before JSON encoding. Redaction is not a guarantee that every sensitive value will be detected.
- Thinking blocks, images, and tool-result detail objects are excluded.
- The local evidence packet is capped at 16,000 serialized characters: up to four user messages sharing 4,000 characters, and 32 evidence events with up to 2,000 characters each. These are character limits, not token or total API-request limits; judgment questions add request overhead.
- Omitted or truncated context is marked. Selected truncated evidence cannot support a retained concern. Older instructions and results may be unavailable, so do not infer safety or failure from their absence.

Recorded packets remain subject to your normal OMP session storage and retention. Do not publish real session records or paste credentials into prompts, issues, or replay fixtures.

## Trial evidence

The committed [evaluation-results.json](evaluation-results.json) records a synthetic 11-case live replay on **2026-09-17**, using `jev-1.13.0`:

| Measurement                                             | Observed result |
| ------------------------------------------------------- | --------------- |
| Cases matching expected verdicts and required citations | 10 / 11         |
| Correctly flagged cases / false-positive cases          | 3 / 1           |
| Median evaluation time                                  | 173 ms          |
| Evaluation time range                                   | 132–495 ms      |
| Reported input tokens across the replay                 | 28,959          |

The mismatch is **“unrelated failing test does not contradict scoped success.”** The verification check correctly cleared the scoped parser success, but the instruction check falsely flagged the unrelated billing failure at confidence `0.26`. This is a reason to retain shadow mode, not a reason to redefine the expected outcome.

These observations are neither production accuracy measurements nor latency guarantees. Model responses and service latency can change; deterministic local tests and live replay results are separate forms of evidence.

## Development

Contributor and coding-agent constraints live in [AGENTS.md](AGENTS.md).

Run the local checks from the repository root:

```sh
bun check
bun test
```

`bun check` runs lint, formatting checks, and TypeScript checking. `bun test` runs deterministic local tests without live TypeSafe calls. There is no separate build step; OMP loads the TypeScript extension.

To evaluate the synthetic fixtures against the live service:

```sh
bun run replay --output /tmp/omp-jev-watchdog-replay.json
```

This requires configured TypeSafe credentials and makes billable API requests. The runner resolves credentials through `omp token` internally without printing them. It writes the report even when a case fails and exits nonzero if any verdict or required citation differs from expectations. The historical committed report includes a mismatch; a nonzero replay exit is not necessarily a transport failure. Inspect the report rather than assuming all checks passed.

### Replay reports and baselines

Reports include independent `summary.byCheck.verification` and `summary.byCheck.instruction` counts: verdict matches, citation-aware matches, false positives, missed concerns, citation mismatches, uncertainty, unavailable checks, and typed reasons. `insufficient` and `not_checked` remain coverage gaps, not clear results or missed-concern verdicts. A fixture that expects `insufficient` can match while still recording that uncertainty. Model identities, latency statistics, and token totals are reported separately; joint-request usage is counted once, not once per check.

To compare a later live run against a saved baseline:

```sh
bun run replay --baseline /tmp/omp-jev-watchdog-replay.json --output /tmp/omp-jev-watchdog-comparison.json
```

To analyze saved reports locally, without credentials or API calls:

```sh
bun run replay --input /tmp/omp-jev-watchdog-comparison.json --baseline /tmp/omp-jev-watchdog-replay.json --output /tmp/omp-jev-watchdog-analysis.json
```

`--input` also works without `--baseline`, including `bun run replay --input evaluation-results.json`. Pass counts are recomputed from expected verdicts and citations rather than trusting saved `passed` flags. Offline analysis retains the same nonzero mismatch exit behavior as live replay. Prior evaluations are never sent to Jev.

New reports carry a SHA256 `rubricHash` covering static prompts and an evaluator-contract marker, plus a per-case `fixtureHash` covering the packet and expectations. Packet contents are not added to replay reports. Comparison rows are comparable only when known fixture hashes and expected meanings agree. Rubric and model identities remain visible so a change of evaluator can be assessed on the same fixtures.

Unknown or changed evidence identity produces `incomparable`, never an improvement claim. The committed historical report lacks hashes and typed reasons; these remain unknown rather than being backfilled. Its verdict counts can still be inspected, but its comparison rows are incomparable. Count deltas describe whole-report differences, not matched-only accuracy changes. Losing checking coverage is not resolution, and `improved` means better agreement with a synthetic fixture—not proven improvement on real work.

The CLI refuses to overwrite the committed historical report. Save new reports outside the checkout unless intentionally adding a new, reviewed synthetic trial.

## License

[MIT](LICENSE), copyright 2026 Sean Perkins. Dependencies retain their own licenses.
