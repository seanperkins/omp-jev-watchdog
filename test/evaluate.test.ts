import { describe, expect, test } from "bun:test";
import type { ChoiceAnswer, Questions } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { evaluateWatchdog } from "../src/evaluate";
import type { WatchdogPacket } from "../src/types";
import { REPLAY_CASES } from "./replay-fixtures";

interface WireRequest {
  state: string;
  questions: Questions;
}

interface WireResponse {
  model: string;
  answers: Record<string, ChoiceAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

function responseBody(
  init: RequestInit | undefined,
  selected: Record<string, string> = {},
): WireResponse {
  const request = JSON.parse(String(init?.body)) as WireRequest;
  const answers: Record<string, ChoiceAnswer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type !== "choice") throw new Error("Unexpected non-choice question");
    const choice =
      selected[id] ?? (id === "instruction" || id === "verification" ? "clear" : "__none__");
    answers[id] = {
      type: "choice",
      choice,
      confidence: 0.83,
      probabilities: Object.fromEntries(
        Object.keys(question.criteria).map((label) => [label, label === choice ? 1 : 0]),
      ),
    };
  }
  return { model: "jev-fixture-actual", answers, usage: { input_tokens: 321, output_tokens: 7 } };
}

function fixture(name: string): WatchdogPacket {
  const found = REPLAY_CASES.find((item) => item.name === name);
  if (found === undefined) throw new Error(`Missing fixture ${name}`);
  return structuredClone(found.packet);
}

const failurePacket = (): WatchdogPacket => fixture("failed verification contradicts pass claim");

describe("native TypeSafe watchdog boundary", () => {
  test("transforms valid closed choices into an evidence-located candidate and preserves actual usage", async () => {
    let calls = 0;
    const transport: FetchImpl = async (_input, init) => {
      calls++;
      return Response.json(
        responseBody(init, {
          verification: "concern",
          verification_claim: "e3",
          verification_evidence: "e2",
        }),
      );
    };
    const result = await evaluateWatchdog(failurePacket(), {
      apiKey: "local-test-only",
      fetch: transport,
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({
      status: "checked",
      model: "jev-fixture-actual",
      inputTokens: 321,
      outputTokens: 7,
    });
    expect(result.checks.find((check) => check.kind === "verification")).toMatchObject({
      kind: "verification",
      verdict: "concern",
      confidence: 0.83,
      evidenceIds: ["e3", "e2"],
    });
  });

  test("instruction candidates require both action and explicit user instruction", async () => {
    const packet = fixture("explicit forbidden file action is a candidate conflict");
    const result = await evaluateWatchdog(packet, {
      apiKey: "local-test-only",
      fetch: async (_input, init) =>
        Response.json(
          responseBody(init, {
            instruction: "concern",
            instruction_evidence: "e1",
            instruction_rule: "u1",
          }),
        ),
    });
    expect(result.status).toBe("checked");
    expect(result.checks.find((check) => check.kind === "instruction")).toMatchObject({
      kind: "instruction",
      verdict: "concern",
      confidence: 0.83,
      evidenceIds: ["e1"],
      instructionId: "u1",
    });
  });

  test("working phase emits no verification assessment", async () => {
    const packet = failurePacket();
    packet.phase = "working";
    const result = await evaluateWatchdog(packet, {
      apiKey: "local-test-only",
      fetch: async (_input, init) => Response.json(responseBody(init)),
    });
    expect(result.status).toBe("checked");
    expect(result.checks.map((check) => check.kind)).toEqual(["instruction"]);
  });

  test("missing verification evidence stays insufficient rather than clear or concern", async () => {
    const packet = fixture("unverified pass claim is insufficient not failure");
    const result = await evaluateWatchdog(packet, {
      apiKey: "local-test-only",
      fetch: async (_input, init) =>
        Response.json(responseBody(init, { verification: "insufficient" })),
    });
    expect(result.status).toBe("checked");
    expect(result.checks.find((check) => check.kind === "verification")).toMatchObject({
      verdict: "insufficient",
      evidenceIds: [],
    });
  });

  test("truncated cited evidence withholds a concern", async () => {
    const packet = failurePacket();
    const resultEvidence = packet.evidence.find((item) => item.id === "e2");
    if (resultEvidence === undefined) throw new Error("Missing result evidence");
    resultEvidence.truncated = true;
    const result = await evaluateWatchdog(packet, {
      apiKey: "local-test-only",
      fetch: async (_input, init) =>
        Response.json(
          responseBody(init, {
            verification: "concern",
            verification_claim: "e3",
            verification_evidence: "e2",
          }),
        ),
    });
    expect(result.status).toBe("checked");
    expect(result.checks.find((check) => check.kind === "verification")).toMatchObject({
      verdict: "insufficient",
      evidenceIds: [],
    });
  });

  test("HTTP 429 aborts the request and is not retried or exposed", async () => {
    let attempts = 0;
    let requestSignal: AbortSignal | null | undefined;
    const result = await evaluateWatchdog(failurePacket(), {
      apiKey: "credential-never-output",
      fetch: async (_input, init) => {
        attempts++;
        requestSignal = init?.signal;
        return new Response("private server body", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      },
    });
    expect(attempts).toBe(1);
    expect(requestSignal?.aborted).toBe(true);
    expect(result).toMatchObject({ status: "not_checked", reason: "unavailable", checks: [] });
    expect(JSON.stringify(result)).not.toContain("private server body");
    expect(JSON.stringify(result)).not.toContain("credential-never-output");
  });

  test("network failure is not retried and its exception text is not retained", async () => {
    let attempts = 0;
    const result = await evaluateWatchdog(failurePacket(), {
      apiKey: "local-test-only",
      fetch: async () => {
        attempts++;
        throw new Error("private network diagnostic");
      },
    });
    expect(attempts).toBe(1);
    expect(result).toMatchObject({ status: "not_checked", reason: "unavailable", checks: [] });
    expect(JSON.stringify(result)).not.toContain("private network diagnostic");
  });

  test("total deadline aborts even a transport that ignores cancellation", async () => {
    let requestSignal: AbortSignal | null | undefined;
    let attempts = 0;
    const result = await evaluateWatchdog(failurePacket(), {
      apiKey: "local-test-only",
      timeoutMs: 20,
      fetch: (_input, init) => {
        attempts++;
        requestSignal = init?.signal;
        return new Promise<Response>(() => {});
      },
    });
    expect(result).toMatchObject({ status: "not_checked", reason: "timeout", checks: [] });
    expect(requestSignal?.aborted).toBe(true);
    expect(attempts).toBe(1);
  });

  test("total deadline includes unresolved credentials and never starts HTTP", async () => {
    let authSignal: AbortSignal | undefined;
    let attempts = 0;
    const result = await evaluateWatchdog(failurePacket(), {
      apiKey: (context) => {
        authSignal = context.signal;
        return new Promise<string>(() => {});
      },
      timeoutMs: 20,
      fetch: async () => {
        attempts++;
        return new Response("unexpected");
      },
    });
    expect(result).toMatchObject({ status: "not_checked", reason: "timeout", checks: [] });
    expect(authSignal?.aborted).toBe(true);
    expect(attempts).toBe(0);
  });

  test("already-cancelled callers perform no credential or HTTP work", async () => {
    let attempts = 0;
    const result = await evaluateWatchdog(failurePacket(), {
      apiKey: () => {
        attempts++;
        return "local-test-only";
      },
      signal: AbortSignal.abort(),
      fetch: async () => {
        attempts++;
        return new Response("unexpected");
      },
    });
    expect(attempts).toBe(0);
    expect(result).toMatchObject({ status: "not_checked", reason: "unavailable", checks: [] });
  });

  test("malformed successful HTTP payload is withheld", async () => {
    const result = await evaluateWatchdog(failurePacket(), {
      apiKey: "local-test-only",
      fetch: async () => new Response("{invalid JSON", { status: 200 }),
    });
    expect(result).toMatchObject({ status: "not_checked", reason: "invalid_response", checks: [] });
  });

  test("unknown evidence IDs cannot become candidate citations", async () => {
    const result = await evaluateWatchdog(failurePacket(), {
      apiKey: "local-test-only",
      fetch: async (_input, init) => {
        const body = responseBody(init, {
          verification: "concern",
          verification_claim: "e3",
          verification_evidence: "nonexistent",
        });
        return Response.json(body);
      },
    });
    expect(result).toMatchObject({ status: "not_checked", reason: "invalid_response", checks: [] });
  });

  test("missing required answers are withheld", async () => {
    const result = await evaluateWatchdog(failurePacket(), {
      apiKey: "local-test-only",
      fetch: async (_input, init) => {
        const body = responseBody(init);
        delete body.answers.instruction;
        return Response.json(body);
      },
    });
    expect(result).toMatchObject({ status: "not_checked", reason: "invalid_response", checks: [] });
  });

  test("a concern without a supporting citation is withheld", async () => {
    const result = await evaluateWatchdog(failurePacket(), {
      apiKey: "local-test-only",
      fetch: async (_input, init) =>
        Response.json(responseBody(init, { verification: "concern", verification_claim: "e3" })),
    });
    expect(result).toMatchObject({ status: "not_checked", reason: "invalid_response", checks: [] });
  });

  test("clear verdict with conflicting nonempty citations is withheld", async () => {
    const result = await evaluateWatchdog(failurePacket(), {
      apiKey: "local-test-only",
      fetch: async (_input, init) =>
        Response.json(
          responseBody(init, { verification_claim: "e3", verification_evidence: "e2" }),
        ),
    });
    expect(result).toMatchObject({ status: "not_checked", reason: "invalid_response", checks: [] });
  });
});
