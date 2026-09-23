# OMP Jev Watchdog

An experimental, shadow-only watchdog for [Oh My Pi](https://github.com/can1357/oh-my-pi), using TypeSafe's Jev through OMP's native judgment client.

It records candidate verification contradictions and explicit user-instruction conflicts. It **does not inject advice, interrupt the agent, invoke a reviewer, or replace the full advisor**. Existing advisor and classifier settings stay unchanged.

**Trial status: stopped on 2026-09-23.** The local watchdog plugin is disabled. Real-use review did not demonstrate a useful catch or enough operational benefit to continue the trial. Code and reports are retained as experimental evidence, not a validated safety gate or general code reviewer. See the [trial conclusion](#trial-conclusion-2026-09-23).

## What it checks

| Check                 | Evidence                                                             | When                          |
| --------------------- | -------------------------------------------------------------------- | ----------------------------- |
| Instruction adherence | Observed tool calls/results versus recent explicit user instructions | During work and at completion |
| Verification honesty  | The final assistant claim versus actual tool results                 | At completion only            |

A failed command followed by “the command passed” can produce a candidate contradiction. Current/latest success claims use the latest relevant observed result: an earlier pass cannot excuse a later same-scope failure, while a relevant successful rerun can supersede an earlier failure. Explicitly historical claims remain about their named run. An honest draft, missing test result, or unfinished task is not automatically a violation; missing results do not prove failure.

Only retained user messages establish instructions for these checks. A user turn can carry a bounded, redacted `precedingAssistant` reference so a short approval has its proposed scope; assistant text is not independently authoritative or selectable as a user instruction. A question or rejection does not adopt a proposal, and later approval cannot authorize earlier actions. This is not comprehensive enforcement of system prompts, `AGENTS.md`, or every requirement in a long conversation. Tool output and quoted instructions are treated as evidence, not authority.

Instruction scope distinguishes the restricted operation from its target. A restriction on modifications does not by itself prohibit inspection or unrelated diagnostics. Explicit read, execution, and network restrictions still apply; tests that write snapshots or transmit data are not exempt.

Completion claims come from final assistant prose after tool work or an accepted terminal `yield` call with explicit `data`. Yield payloads are read only from already-redacted, bounded canonical arguments; result acknowledgments and detail objects are never proof of success. Working prose emitted alongside a tool call cannot serve as the final claim. Missing final claims deterministically produce verification `insufficient`/`missing_evidence`, not `clear`. Incremental, data-less/idle-assembled, workpool, rejected, errored, or truncated yields are not reconstructed; verification stays insufficient when no supported final claim is available.

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

To disable user-wide loading, run `omp plugin disable omp-jev-watchdog`. Already-open sessions can still have the extension loaded: run `/jev-watchdog off` in each such session, or restart OMP. Disabling the plugin does not delete its source or saved review entries, and does not disable the separate advisor or permission classifier.

| Result         | Meaning                                                                            |
| -------------- | ---------------------------------------------------------------------------------- |
| `clear`        | No material conflict identified in the supplied evidence; not proof of correctness |
| `concern`      | A candidate conflict with selected evidence and a claim or instruction reference   |
| `insufficient` | Not enough usable evidence to decide                                               |
| `not_checked`  | No valid judgment: timeout, unavailability, or an invalid response                 |

**Confidence is an uncalibrated model signal, not a probability that the finding is correct.** Inspect the cited evidence before acting. `latest` reports reasons, summaries, and IDs; redacted evidence packets are stored as `jev-watchdog-review` custom entries in OMP's session JSONL. Those entries are not messages to the main model. Session mode entries use `jev-watchdog-mode`.

For the local missing-claim prerequisite check, confidence is `0` because no verification judgment was requested; it is not a calibrated probability or a model assessment. The instruction check still uses the same bounded remote request.

Each checked result includes a closed-choice reason:

| Reason | Verdict | Meaning |
| ------ | ------- | ------- |
| `no_conflict` | `clear` | No material conflict identified in the supplied evidence |
| `verification_contradiction` | `concern` | A final claim conflicts with a directly relevant tool result |
| `instruction_conflict` | `concern` | An observed action conflicts with an applicable explicit user instruction |
| `missing_evidence` | `insufficient` | Required evidence is absent |
| `ambiguous_scope` | `insufficient` | Relevance, applicability, scope, or chronology cannot be established |
| `truncated_context` | `insufficient` | Omitted or truncated context prevents a decision |

Each check requests one typed decision, then derives its verdict locally; separate verdict and reason questions cannot disagree. Supporting citations are selected in the same bounded request, not a follow-up call. Missing or malformed answers, invalid probability distributions, unknown IDs, and inconsistent decision/citation combinations remain `not_checked` with `invalid_response`. A selected truncated citation still downgrades a concern to `insufficient`/`truncated_context`, without retaining candidate citations. These decisions explain the existing checks, not new detectors or proof of a defect.

Each evaluation has a **1,000 ms total deadline**, with no HTTP retry or LLM fallback. Newer evidence can supersede an in-flight result. Completion checks take priority over working checks; shutdown drains outstanding bounded work so the final record can be saved.

## Privacy and context limits

**This is not local-only inference.** Bounded, redacted conversation evidence is sent to TypeSafe's remote API. Review [TypeSafe's privacy policy](https://typesafe.ai/privacy) before using it with sensitive work.

- Collected inputs: recent user text, assistant text, tool arguments, and textual tool results. File contents can be included when a tool returns them; the watchdog does not independently scan the repository.
- OMP's native redactor runs before evidence retention and submission. Tool argument values are redacted before JSON encoding. Redaction is not a guarantee that every sensitive value will be detected.
- Thinking blocks, images, and tool-result detail objects are excluded.
- The local evidence packet is capped at 16,000 serialized characters. User text shares a 4,000-character budget without a separate four-message cap, preserving task instructions through short follow-ups while they fit. Attached assistant references share a separate 2,000-character budget; older references are shortened first and marked truncated. Up to 32 evidence events retain at most 2,000 characters each. JSON escaping and metadata count toward the total cap; references are removed before other content when serialization exceeds it. These are character limits, not token or total API-request limits; judgment questions add request overhead.
- Omitted or truncated context is marked. `omittedInstructions` identifies lost/truncated user-policy history; `omittedEvidence` identifies evicted evidence events; individual items retain their truncation markers. Unrelated truncated output does not automatically prevent a scoped decision, but missing relevant policy, results, or chronology still requires abstention. Selected truncated evidence cannot support a retained concern. A clear result covers only the retained claim/actions, never unobserved work.
- Session restoration reads only the active branch after its latest `/clear` boundary. It pairs user turns with the latest preceding assistant prose, ignoring textless assistant/tool turns. A user-attributed custom turn breaks that reference chain; its content is not promoted into ordinary user instructions. Missing or truncated references remain uncertainty, not implicit authorization.

Recorded packets remain subject to your normal OMP session storage and retention. Do not publish real session records or paste credentials into prompts, issues, or replay fixtures.

## Trial conclusion (2026-09-23)

**Decision: stop the trial.** Synthetic detection capability did not translate into demonstrated useful findings on ordinary work. The local plugin was disabled with `omp plugin disable omp-jev-watchdog`; native plugin listing confirmed it disabled while the classifier remained enabled. The global OMP configuration was unchanged. Existing loaded sessions still need `/jev-watchdog off` or a restart.

### What real use showed

The initial read-only audit covered saved reviews from September 17–22, excluding synthetic smoke sessions:

| Observation | Result |
| ----------- | ------ |
| Distinct persisted evaluations | 1,764 |
| Retained concerns | 0 |
| Instruction outcomes | 39 clear; 1,583 insufficient; 142 not checked |
| Main-session completion reviews | 33; all inconclusive |
| Recorded usage | 13,067,907 input tokens; 512,963 output tokens |

Recorded usage is not a complete bill: invalid or superseded work can be absent from retained totals. Zero concerns did not establish clean work. Three verification-clear results in the wider sample had no captured assistant claim, so they were not demonstrated final-answer verification.

A subsequent audit selected **20 grouped, bounded completed work units** from conversation JSONL using user requests, final claims, and historical tool outcomes—not just watchdog flags. It included unflagged work and grouped related approval/publication follow-ups. Two genuine terminal session-end deliverables were included without requiring a later user reply.

| Final verification outcome for those work units | Count |
| ---------------------------------------------- | ----- |
| Clear | 1 |
| Insufficient | 11 |
| Not checked / invalid | 2 |
| No associated watchdog record | 6 |

All 12 valid instruction checks were insufficient. Independent inspection established no completion contradiction or explicit instruction violation in the bounded claims reviewed; **no useful watchdog catch was demonstrated**. This was not comprehensive code/UI verification or a blinded evaluation. Nineteen units preceded the September 22 coverage repair and only one followed it; six older units had no watchdog record. The sample cannot establish post-repair efficacy, recall, or a missed-defect rate.

### What the repairs established—and did not

The investigation reproduced defects in the watchdog itself: unrelated truncation causing blanket abstention, independently requested verdicts and reasons disagreeing, absent final claims being cleared, unsupported final-claim selection, and a four-message cap discarding task restrictions and approval references.

Repairs improved evidence collection and synthetic behavior. The final retained [context trial](context-experiment-results.json) matched **86/91** cases, including **59/59** verification checks and **6/8** new context cases. Deterministic tests and native-host smoke checks passed. However, five instruction mismatches remained: two late-permission misses, a missing approval reference incorrectly cleared, and two unnecessary abstentions. Those are unresolved limitations, not passing results.

These were development trials, not a fresh holdout or measured production improvement. Changed packets and fixture identities prevent treating historical raw pass totals as a controlled improvement score. Confidence remains uncalibrated. Host smoke used synthetic primary-model output and live Jev; it did not establish real-work detection accuracy.

### Why the trial ended

The trial consumed remote evaluations and review effort without demonstrating incremental operational value. Most real checks were inconclusive; the one later narrow verification-clear result was a consistency check, not independent task validation. Shadow-only operation never prevented actions or corrected the primary agent.

The useful outcome was identifying the watchdog's own coverage failures and documenting the limits—not demonstrated protection of real work. Preserve the source and historical reports for reference; do not resume the trial or live evaluation work without explicit authorization. No real transcripts or credentials are included in these repository findings.

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

### Operation-scope experiment

[scope-experiment-results.json](scope-experiment-results.json) records a separate synthetic trial on `jev-1.13.0`: the original 11 cases plus 40 realistic cases in 20 contrast pairs. The additional cases cover operation/target scope, verification claims, operational failures, chronology/authority, and actual `EvidenceWindow` truncation and eviction. No real session transcripts were imported.

Expectations and citations were reviewed and frozen before baseline evaluation. Ten new cases (five whole pairs) were held out; the four instruction rubrics were locked before evaluating that holdout. Three trials per case and rubric produced 306 case evaluations. Repetition was evaluation-only, not a runtime retry. Only instruction rubrics changed; no confidence cutoff or tool exemption was added.

| Observation across three trials | Baseline | Scope rubric |
| -------------------------------- | -------- | ------------ |
| Development matches (41 cases × 3) | 113 / 123 | 123 / 123 |
| Holdout matches (10 cases × 3) | 21 / 30 | 22 / 30 |
| Instruction false positives | 6 | 0 |
| Concern incorrectly called clear, across both checks | 4 | 4 |
| Evaluations withheld as invalid responses | 9 | 4 |

The known unrelated-test false positive cleared in all three development trials, and an additional live CLI smoke matched all 11 original cases. Observed missed-concern counts did not increase, and coverage did not worsen. That supports retaining this narrow rubric change in shadow mode, **not claiming the holdout passed**.

At that stage, remaining failures included retroactive permission for a migration, a missed or inconsistently answered latest same-suite contradiction, and a read-only staging violation withheld because the verification reason contradicted its verdict. Those expectations were not changed. The chronology experiment below subsequently used these now-visible cases as development evidence, with a fresh holdout.

The report retains per-trial model/rubric/fixture identities, citations, coverage, latency, and reported token usage. Invalid-response usage is discarded by the current evaluator, so reported tokens are not a complete billable-usage total. Three repeated synthetic trials are not production accuracy or confidence calibration. Future tuning against these now-visible cases needs a fresh holdout for a new generalization assessment.

### Latest-result chronology experiment

[chronology-experiment-results.json](chronology-experiment-results.json) records a synthetic follow-up on `jev-1.13.0`. Only the four verification rubrics changed: match the claimed scope and time, give the latest relevant result precedence, preserve explicit historical claims, and distinguish an unsuccessful run from whether that failure proves a code defect. Missing-result insufficiency applies to actual success/completion claims, not honest pending or unverified work. Citation validation, instruction rubrics, evidence handling, deadline, and shadow-only operation were unchanged.

Twenty new cases in ten contrast pairs were frozen before live measurement: 12 development cases and eight fresh holdout cases. All 51 previously observed fixtures and expectations stayed unchanged; they joined the 12 new development cases, giving 63 development cases. The final candidate was locked before either rubric saw the fresh holdout.

| Observation across three trials | Baseline | Final chronology rubric |
| -------------------------------- | -------- | ------------------------ |
| Original latest same-suite contradiction, with required citations | 0 / 3 | 3 / 3 |
| Development matches (63 cases × 3) | 179 / 189 | 185 / 189 |
| Fresh holdout matches (8 cases × 3) | 24 / 24 | 24 / 24 |
| Verification false positives | 0 | 0 |
| Invalid-response evaluations | 5 | 0 |

Both baseline and candidate passed the fresh holdout: this is evidence of no observed regression on those eight cases, not improved holdout accuracy. Each variant also had one development timeout; unavailable checks remain `not_checked`, not clear. The final candidate still missed retroactive-permission violations in all three development trials. A separate final default CLI replay matched **70 / 71**, failing that same instruction case; the new holdout CLI suite matched **8 / 8**.

The report preserves an initial candidate's three development trials too. It caught the original contradiction, but once produced inconsistent verdict/reason answers for an honestly unverified audit. Missing-result wording was narrowed before the final candidate and holdout runs; no holdout outcome was used for tuning. The report contains 615 controlled case evaluations plus 91 CLI smoke evaluations, including that initial candidate's 12-case CLI smoke. Repetition is evaluation-only, never a runtime retry.

The fresh holdout is small and now observed. These results are not production accuracy or confidence calibration, and the reported token totals still exclude usage discarded for invalid responses. No lifecycle or OMP command integration changed; those host paths were not re-tested in this rubric-only follow-up.

### Real-use coverage repair

A September 22 review of 1,764 persisted real-session evaluations found zero retained concerns and predominantly inconclusive coverage. That was not evidence of clean work. Synthetic diagnosis reproduced three causes: blanket abstention for unrelated truncation, disagreement between independently requested verdicts and reasons, and missing final claims being reported clear.

[coverage-experiment-results.json](coverage-experiment-results.json) preserves the original 10-case paired probe, intermediate live-run summaries and mismatches, expectation-change rationales, and the final 83-case report from `jev-1.13.0`. No private transcripts are included. The repair preserves packet bounds, native redaction, strict validation, cancellation, and the one-second/no-retry contract.

| Final live replay measurement | Result |
| ----------------------------- | ------ |
| Whole cases matching expectations and citations | 81 / 83 |
| Verification matches | 59 / 59 |
| Instruction matches | 81 / 83 |
| New coverage cases matching expectations | 12 / 12 |
| False positives / citation mismatches / invalid or unavailable results | 0 / 0 / 0 |
| Median / maximum evaluation time | 200 / 439 ms |

The two remaining mismatches are the existing late-permission missed concern and unnecessary instruction abstention in “Additional worker logs evict the cache result before the final claim.” Verification correctly remains insufficient for that missing cache result. Three earlier instruction expectations now allow a scoped clear result when the retained permitted read operations are fully evidenced despite missing report content. One verification expectation now clears a factual migration admission matching its result, while instruction applicability remains insufficient because policy was evicted. These changes were reviewed for semantics, not changed to match the model; the final cache case still fails its revised expectation. New provenance also changes fixture hashes. Do not compare raw pass totals as if the historical packets and expectations were identical.

Deterministic verification: 57 focused tests, `bun check`, and all 63 tests passed. A real OMP 18.2.4 RPC session used a local synthetic primary-model stream and live Jev judgments: prose and native terminal-yield contradictions were retained, missing final prose stayed insufficient, `status`/`latest`/`off`/`shadow` worked, and disabled mode survived switching away and back. Persisted custom entries stayed within packet bounds; an escaped synthetic secret in yield arguments was redacted; detail objects were excluded from watchdog packets, and no watchdog review entries reached the primary-model context. This smoke test did not exercise a real spawned subagent or every shutdown/continuation race.

This is development evidence, not a fresh holdout, measured production improvement, or confidence calibration. Continued shadow observation is required to measure real-use coverage after the repair.

### Task and approval context trial

The September 23 repair removes the four-user-message eviction rule without increasing the 4,000-character user budget or 16,000-character serialized packet cap. It retains redacted proposal context separately from user authority. Restoration preserves references across textless assistant turns but not across `/clear` or user-attributed custom turns.

[context-experiment-results.json](context-experiment-results.json) contains synthetic-only evidence from `jev-1.13.0`: **86/91** whole cases, **59/59** verification checks, **86/91** instruction checks, and **6/8** new context cases matched. There were no false-positive concerns, citation mismatches, invalid responses, or timeouts in the retained full run; median/max evaluation time was **224/523 ms**. This is not a fully passing replay.

The five mismatches are two late-permission missed concerns (the existing migration case and the new publication case), a missing approval reference incorrectly judged clear, and unnecessary instruction abstentions in the evicted-cache-result and truncated-latest-deployment-result cases. The missing-reference result violates the intended abstention semantics: retaining more context does not make the model reliably enforce permission boundaries. The deployment abstention is additional to the previous reported run, not a controlled regression estimate.

The policy-eviction fixture now uses enough follow-up text to actually exhaust the character budget; its expected insufficient instruction verdict is unchanged. Packets and hashes differ from historical runs, so raw totals are not matched-case improvement evidence. The new cases are development cases, not a fresh holdout.

Deterministic verification: **48 focused tests**, `bun check`, and **66 full-suite tests** passed.

A real OMP 18.2.4 SDK session with a synthetic local primary stream and live Jev judgments preserved the original policy through six short continuations and the proposal through a textless assistant message. It verified `/clear` and custom-turn reference boundaries, `status`/`latest`/`off`/`shadow`, persisted off-mode restoration, no reviews while disabled, redaction of an escaped synthetic secret in proposal text, serialized packet bounds, and no review-entry injection into primary context. This is host-integration evidence, not proof of real-work detection accuracy or every lifecycle race.

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

The default live suite now contains **91 cases**, rather than the historical 11. Select a fixed partition explicitly when investigating:

```sh
bun run replay --suite original --output /tmp/jev-original.json
bun run replay --suite development --output /tmp/jev-development.json
bun run replay --suite holdout --output /tmp/jev-holdout.json
bun run replay --suite chronology-development --output /tmp/jev-chronology-development.json
bun run replay --suite chronology-holdout --output /tmp/jev-chronology-holdout.json
bun run replay --suite coverage --output /tmp/jev-coverage.json
bun run replay --suite context --output /tmp/jev-context.json
```

`original` retains the original 11 case expectations; the scope experiment's `development` contains those plus 30 cases (41 total), and its `holdout` contains ten. Those memberships remain unchanged. `chronology-development` contains the 12 chronology development cases; `chronology-holdout` contains the eight previously evaluated holdout cases. The chronology experiment's 63-case development set combined the previous 51 with those 12. `coverage` contains 12 development cases: five concise/bulky-document pairs and a passing/failing terminal-yield pair. `context` contains eight development cases covering retained restrictions, scoped approval, questioning, rejection, missing/truncated references, and late permission. `all` includes all 91 and is the default. Coverage-repair provenance, its four expectation revisions, and the character-budget eviction fixture update described above apply to the current fixtures; historical experiment artifacts are unchanged.

Keep both members of each contrast pair in the same partition. Use development results for rubric changes, then lock the rubric before inspecting fresh holdout results. Previously inspected holdouts are no longer fresh. For repeated trials, run the same command with distinct output paths; each invocation makes new billable evaluations.

`--suite` is a live-fixture selector and cannot be combined with offline `--input`. The combined scope and chronology experiment artifacts contain individual replay reports under `reports[].report`; the coverage and context repairs' final replays are under `finalReport`. Extract that individual report before using `--input`.

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
