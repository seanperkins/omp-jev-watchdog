import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { buildSecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { ShadowWatchdog } from "./controller";
import { evaluateWatchdog } from "./evaluate";
import { EvidenceWindow, MAX_USER_MESSAGES } from "./packet";
import { obfuscateToolArguments } from "@oh-my-pi/pi-coding-agent/secrets/message-transform";

const RECORD_TYPE = "jev-watchdog-review";
const MODE_TYPE = "jev-watchdog-mode";
const STATUS_KEY = "jev-watchdog";
const DISPLAY_WIDTH = 100;

export default function jevWatchdog(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let window: EvidenceWindow | undefined;
  let available = false;
  let lifecycle = 0;

  const refresh = (): void => {
    if (!context) return;
    const stats = controller.stats;
    const state = !controller.enabled
      ? "off"
      : !available
        ? "unavailable"
        : controller.busy
          ? "checking"
          : "shadow";
    const latest = controller.latest;
    const result = latest
      ? latest.status === "not_checked"
        ? `; not checked (${latest.reason})`
        : `; ${latest.durationMs}ms`
      : "";
    context.ui.setStatus(
      STATUS_KEY,
      `Jev ${state} · ${stats.checked} checked · ${stats.concerns} candidates${result}`,
    );
  };

  const controller = new ShadowWatchdog({
    evaluate: (packet, signal) => {
      if (!context) throw new Error("Watchdog session unavailable");
      return evaluateWatchdog(packet, {
        apiKey: context.modelRegistry.authStorage.resolver("typesafe", {
          sessionId: context.sessionManager.getSessionId(),
        }),
        signal,
      });
    },
    record: (record) => {
      // Custom entries are local session records, never messages to the primary model.
      pi.appendEntry(RECORD_TYPE, record);
    },
    changed: refresh,
  });

  const restoreUserContext = (ctx: ExtensionContext): string | undefined => {
    if (!window) return;
    const branch = ctx.sessionManager.getBranch();
    const messages: string[] = [];
    // One extra message lets the packet builder mark older context as omitted.
    for (
      let index = branch.length - 1;
      index >= 0 && messages.length <= MAX_USER_MESSAGES;
      index--
    ) {
      const entry = branch[index];
      if (!entry || entry.type !== "message" || entry.message.role !== "user") continue;
      const content = entry.message.content;
      const text =
        typeof content === "string"
          ? content
          : content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n");
      messages.push(text);
    }
    for (let index = messages.length - 1; index >= 0; index--) window.addUser(messages[index]!);
    return messages[0];
  };

  const initialize = async (ctx: ExtensionContext): Promise<void> => {
    const generation = ++lifecycle;
    context = ctx;
    controller.reset();
    window = undefined;
    available = false;
    try {
      const obfuscator = await buildSecretObfuscator(ctx.cwd, getAgentDir());
      if (generation !== lifecycle) return;
      // Refuse remote review if the native redactor could not be initialized.
      if (!obfuscator) {
        refresh();
        return;
      }
      window = new EvidenceWindow(
        (text) => obfuscator.obfuscate(text),
        (args) => obfuscateToolArguments(obfuscator, args),
      );
      restoreUserContext(ctx);
      available = ctx.modelRegistry.authStorage.hasAuth("typesafe");
      let enabled = true;
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "custom" || entry.customType !== MODE_TYPE) continue;
        if (entry.data === "off") enabled = false;
        else if (entry.data === "shadow") enabled = true;
      }
      controller.setEnabled(enabled);
    } catch {
      // Credential/secret-loader exceptions can contain sensitive text.
      pi.logger.warn(
        "Jev watchdog unavailable: native redaction or authentication initialization failed",
      );
    }
    if (generation === lifecycle) refresh();
  };

  pi.on("session_start", (_event, ctx) => initialize(ctx));
  pi.on("session_switch", (_event, ctx) => initialize(ctx));
  pi.on("session_branch", (_event, ctx) => initialize(ctx));
  pi.on("session_tree", (_event, ctx) => initialize(ctx));
  pi.on("session_compact", (_event, ctx) => initialize(ctx));

  pi.on("before_agent_start", (event, ctx) => {
    context = ctx;
    controller.reset();
    if (!window) return;
    window.reset();
    const latestPrompt = restoreUserContext(ctx);
    if (latestPrompt !== event.prompt) window.addUser(event.prompt);
    available = ctx.modelRegistry.authStorage.hasAuth("typesafe");
    refresh();
  });

  pi.on("tool_result", (event, ctx) => {
    context = ctx;
    if (!window || !controller.enabled || !available) return;
    window.addToolCall(event.toolCallId, event.toolName, event.input);
    const text = event.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    window.addToolResult(event.toolCallId, event.toolName, text, event.isError);
  });

  pi.on("turn_end", (event, ctx) => {
    context = ctx;
    if (!window || !controller.enabled || !available) return;
    const message = event.message;
    if (message.role !== "assistant") return;
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    window.addAssistant(text);
    // Verification is deliberately withheld until the genuine completion boundary.
    if (message.content.some((block) => block.type === "toolCall")) {
      const packet = window.snapshot("working");
      if (packet) controller.submit(packet);
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    context = ctx;
    if (event.willContinue || !window || !controller.enabled || !available) return;
    const packet = window.snapshot("complete");
    if (packet) controller.submit(packet);
    // The answer is already streamed; this does not delay primary-model generation.
    await controller.flush();
  });

  pi.on("session_shutdown", async () => {
    lifecycle++;
    // OMP emits agent_end asynchronously. Shutdown is the awaited persistence barrier.
    await controller.flush();
    controller.setEnabled(false);
    window = undefined;
    context?.ui.setStatus(STATUS_KEY, undefined);
    context = undefined;
  });

  pi.registerCommand("jev-watchdog", {
    description: "Jev shadow trial: status, latest, shadow, off (never steers the agent)",
    handler: async (args, ctx) => {
      context = ctx;
      const action = args.trim() || "status";
      if (action === "off" || action === "shadow") {
        controller.setEnabled(action === "shadow");
        pi.appendEntry(MODE_TYPE, action);
        refresh();
        ctx.ui.notify(
          `Jev watchdog ${action} for this session. The full advisor and classifier are unchanged.`,
          "info",
        );
        return;
      }
      if (action === "latest") {
        const latest = controller.latest;
        if (!latest) {
          ctx.ui.notify("No Jev check recorded since this prompt began.", "info");
          return;
        }
        const lines = [
          `Jev shadow: ${latest.status}; ${latest.durationMs}ms; model ${latest.model ?? "unavailable"}`,
          ...latest.checks.flatMap((check) => [
            `${check.kind}: ${check.verdict} (${Math.round(check.confidence * 100)}% model confidence)`,
            `Reason: ${check.reason}`,
            check.summary,
            `Evidence: ${check.evidenceIds.join(", ") || "none"}${check.instructionId ? `; instruction: ${check.instructionId}` : ""}`,
          ]),
          latest.reason
            ? `Not checked: ${latest.reason}`
            : "Shadow findings are candidates, not verified defects. No advice was injected.",
          "Redacted evidence is saved in this session's jev-watchdog-review entries.",
        ];
        ctx.ui.notify(
          lines
            .map((line) => truncateToWidth(replaceTabs(Bun.stripANSI(line)), DISPLAY_WIDTH))
            .join("\n"),
          "info",
        );
        return;
      }
      if (action !== "status") {
        ctx.ui.notify("Usage: /jev-watchdog status | latest | shadow | off", "info");
        return;
      }
      refresh();
      const stats = controller.stats;
      ctx.ui.notify(
        [
          `Jev watchdog: ${controller.enabled ? "shadow" : "off"}; native TypeSafe ${available ? "credential configured" : "unavailable"}.`,
          `This prompt: ${stats.requests} requests, ${stats.checked} checked, ${stats.notChecked} not checked, ${stats.concerns} candidate findings.`,
          `Usage: ${stats.inputTokens} input / ${stats.outputTokens} output tokens. Deadline: 1000ms; no retry or LLM fallback.`,
          "No agent steering. Full advisor and classifier settings unchanged.",
        ].join("\n"),
        "info",
      );
    },
  });
}
