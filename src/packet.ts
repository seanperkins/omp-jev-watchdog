import type { Evidence, EvidenceKind, WatchdogPacket, WatchdogPhase } from "./types";

export const MAX_PACKET_CHARACTERS = 16_000;
export const MAX_USER_CHARACTERS = 4_000;
export const MAX_EVENT_CHARACTERS = 2_000;
export const MAX_EVIDENCE_EVENTS = 32;
export const MAX_USER_MESSAGES = 4;
export const MAX_RECENT_FINGERPRINTS = 128;
export const MAX_METADATA_CHARACTERS = 160;

const EXCERPT_SEPARATOR = "\n[… omitted …]\n";
const MIN_PACKET_EXCERPT_CHARACTERS = 64;

function excerpt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const separator = limit >= EXCERPT_SEPARATOR.length ? EXCERPT_SEPARATOR : "";
  const available = limit - separator.length;
  const beginning = Math.ceil(available / 2);
  const ending = Math.floor(available / 2);
  return text.slice(0, beginning) + separator + (ending > 0 ? text.slice(-ending) : "");
}

function shorten(item: Evidence, limit: number): void {
  if (item.text.length <= limit) return;
  item.text = excerpt(item.text, limit);
  item.truncated = true;
}

/** Only redacted excerpts and a bounded replay fingerprint horizon survive ingestion. */
export class EvidenceWindow {
  #redact: (text: string) => string;
  #redactArguments: (args: Record<string, unknown>) => Record<string, unknown>;
  #revision = 0;
  #nextId = 1;
  #instructions: Evidence[] = [];
  #evidence: Evidence[] = [];
  #seen = new Set<string>();
  #omitted = false;

  constructor(
    redact: (text: string) => string,
    redactArguments: (args: Record<string, unknown>) => Record<string, unknown>,
  ) {
    this.#redact = redact;
    this.#redactArguments = redactArguments;
  }

  reset(): void {
    this.#revision++;
    this.#nextId = 1;
    this.#instructions.length = 0;
    this.#evidence.length = 0;
    this.#seen.clear();
    this.#omitted = false;
  }

  addUser(text: string): void {
    const item = this.#prepare("user", this.#redact(text), MAX_USER_CHARACTERS);
    if (!item) return;
    this.#instructions.push(item);
    while (this.#instructions.length > MAX_USER_MESSAGES) {
      this.#instructions.shift();
      this.#omitted = true;
    }
    let characters = this.#instructions.reduce(
      (total, instruction) => total + instruction.text.length,
      0,
    );
    while (characters > MAX_USER_CHARACTERS) {
      const oldest = this.#instructions[0];
      if (!oldest) break;
      const excess = characters - MAX_USER_CHARACTERS;
      if (oldest.text.length <= excess) {
        characters -= oldest.text.length;
        this.#instructions.shift();
      } else {
        shorten(oldest, oldest.text.length - excess);
        characters -= excess;
      }
      this.#omitted = true;
    }
  }

  addAssistant(text: string): void {
    const item = this.#prepare("assistant", this.#redact(text), MAX_EVENT_CHARACTERS);
    if (item) this.#append(item);
  }

  addToolCall(toolCallId: string, toolName: string, input: Record<string, unknown>): void {
    let serialized: string;
    let omitted = false;
    try {
      const json = JSON.stringify(this.#redactArguments(input));
      serialized = json ?? "[Tool arguments omitted: no JSON representation]";
      omitted = json === undefined;
    } catch {
      serialized = "[Tool arguments omitted: no JSON representation]";
      omitted = true;
    }
    this.#addTool("tool_call", toolCallId, toolName, this.#redact(serialized), omitted);
  }

  addToolResult(toolCallId: string, toolName: string, text: string, isError: boolean): void {
    this.#addTool("tool_result", toolCallId, toolName, this.#redact(text), false, isError);
  }

  snapshot(phase: WatchdogPhase): WatchdogPacket | null {
    if (this.#instructions.length === 0 || this.#evidence.length === 0) return null;
    const packet: WatchdogPacket = {
      revision: this.#revision,
      phase,
      instructions: this.#instructions.map((item) => ({ ...item })),
      evidence: this.#evidence.map((item) => ({ ...item })),
      omitted: this.#omitted,
    };

    // JSON escaping and metadata count toward the actual transport budget too.
    while (JSON.stringify(packet).length > MAX_PACKET_CHARACTERS) {
      packet.omitted = true;
      if (packet.evidence.length > 1) {
        packet.evidence.shift();
        continue;
      }
      if (packet.instructions.length > 1) {
        packet.instructions.shift();
        continue;
      }
      const instruction = packet.instructions[0];
      const evidence = packet.evidence[0];
      if (!instruction || !evidence) return null;
      const longest = instruction.text.length >= evidence.text.length ? instruction : evidence;
      // Both text fields at this floor plus bounded metadata fit even if every
      // character expands to a six-character JSON escape.
      shorten(
        longest,
        Math.max(MIN_PACKET_EXCERPT_CHARACTERS, Math.floor(longest.text.length / 2)),
      );
    }
    return packet;
  }

  #addTool(
    kind: "tool_call" | "tool_result",
    toolCallId: string,
    toolName: string,
    text: string,
    omitted: boolean,
    isError?: boolean,
  ): void {
    const redactedId = this.#redact(toolCallId);
    const redactedName = this.#redact(toolName);
    const metadata: Pick<Evidence, "toolCallId" | "toolName" | "isError" | "truncated"> = {
      toolCallId: redactedId,
      toolName: redactedName,
    };
    if (isError !== undefined) metadata.isError = isError;
    if (omitted) metadata.truncated = true;
    const item = this.#prepare(kind, text, MAX_EVENT_CHARACTERS, metadata);
    if (!item) return;
    if (redactedId.length > MAX_METADATA_CHARACTERS) {
      // A digest preserves call/result joins without collisions from clipped IDs.
      item.toolCallId = `call-${new Bun.CryptoHasher("sha256").update(redactedId).digest("hex")}`;
      item.truncated = true;
    }
    if (redactedName.length > MAX_METADATA_CHARACTERS) {
      item.toolName = excerpt(redactedName, MAX_METADATA_CHARACTERS);
      item.truncated = true;
    }
    this.#append(item);
  }

  #prepare(
    kind: EvidenceKind,
    text: string,
    limit: number,
    metadata: Pick<Evidence, "toolCallId" | "toolName" | "isError" | "truncated"> = {},
  ): Evidence | null {
    if ((kind === "user" || kind === "assistant") && text.trim().length === 0) return null;
    if (kind === "tool_call" || kind === "tool_result") {
      // Fingerprint before excerpting: outputs differing only in their omitted
      // middle and genuinely new tool call IDs must remain distinct events.
      const digest = new Bun.CryptoHasher("sha256")
        .update(JSON.stringify({ kind, text, ...metadata }))
        .digest("hex");
      if (this.#seen.has(digest)) return null;
      this.#seen.add(digest);
      if (this.#seen.size > MAX_RECENT_FINGERPRINTS) {
        const oldest = this.#seen.values().next().value;
        if (oldest !== undefined) this.#seen.delete(oldest);
      }
    }
    const item: Evidence = { id: `e${this.#nextId++}`, kind, text, ...metadata };
    shorten(item, limit);
    if (item.truncated) this.#omitted = true;
    this.#revision++;
    return item;
  }

  #append(item: Evidence): void {
    if (item.truncated) this.#omitted = true;
    this.#evidence.push(item);
    if (this.#evidence.length > MAX_EVIDENCE_EVENTS) {
      this.#evidence.shift();
      this.#omitted = true;
    }
  }
}
