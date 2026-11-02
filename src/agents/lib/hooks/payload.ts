import { byHarness, isAccountProviderAlias, type PerHarness } from "@genesiscz/utils/ai/providers/alias-list";
import { harnessHooks } from "@genesiscz/utils/ai/providers/harness-hooks";
import type { HookFacts } from "@genesiscz/utils/harness/parts";
import { SafeJSON } from "@genesiscz/utils/json";
import type { HarnessName } from "./config";

export interface HookPayload {
    event: string;
    tool: string;
    cwd: string;
    sessionId?: string;
    toolUseId?: string;
    command: string;
    model: string;
    harness: HarnessName;
    /** Files the harness's own renderer already drew, so we do not double-print them. */
    nativeDiffFiles: string[];
    /**
     * The typed hook fields. Every hook reads them here, never `raw.transcript_path` in a feature (lint-rules
     * `no-hook-payload-read`): a harness that spells a field another way is one line in `parseHookPayload`.
     */
    transcriptPath?: string;
    /** Stop hooks: the text of the reply the turn ended with, when the harness sends it. */
    lastAssistantMessage?: string;
    /** Stop hooks: true when this stop is already the result of a Stop hook's "continue". */
    stopHookActive?: boolean;
    /** The tool call's input as the harness sent it; `command` is its shell command when it has one. */
    toolInput?: Record<string, unknown>;
    /** PostToolUse: the tool's result as the harness sent it. */
    toolResponse?: Record<string, unknown>;
    /** Notification hooks: the harness's notification kind (`permission_prompt`, `idle_prompt`, …). */
    notificationType?: string;
    /** Notification hooks: the text the harness shows ("Claude needs your permission to use Bash"). */
    notificationMessage?: string;
    /** UserPromptSubmit: the prompt text. */
    prompt?: string;
    /**
     * The subagent that made the call (Claude's `agent_id`); absent for the main agent. The main agent and its
     * subagents share one session, so capture attribution and a background task's owner both key on it.
     */
    agentId?: string;
    raw: Record<string, unknown>;
}

/** What a hook may assume about the harness that ran it: its driver's `hooks` part (`HookFacts`). */
export type HarnessHookFacts = HookFacts;

/** Each harness's hook facts, read through the light `harness-hooks.ts` door, which loads no driver. */
export const HARNESS_HOOK_FACTS: Readonly<PerHarness<HarnessHookFacts>> = byHarness(harnessHooks);

/** The facts of a harness named by a stored string (a diff-log row); undefined for a name no harness has. */
export function harnessHookFacts(name: string): HarnessHookFacts | undefined {
    return isHarnessName(name) ? HARNESS_HOOK_FACTS[name] : undefined;
}

export function isHarnessName(name: string): name is HarnessName {
    return isAccountProviderAlias(name);
}

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function bool(value: unknown): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}

function str(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

/** `Bash`, `shell`, `run_terminal_command`: the same tool under three harnesses. */
export function isTerminalTool(toolName: unknown): boolean {
    const normalized = String(toolName ?? "")
        .toLowerCase()
        .replace(/_/g, "");

    return normalized === "bash" || normalized === "shell" || normalized === "runterminalcommand";
}

/**
 * Read from the PAYLOAD, never from the environment: a Codex worker spawned from a Claude
 * session inherits every CLAUDE_CODE_* variable. Grok's envelope carries a camelCase
 * `hookEventName` beside Claude's snake_case one; Codex names its `model` and its
 * transcript is a `rollout-<ts>-<uuid>.jsonl`.
 */
export function detectHarness(raw: Record<string, unknown>): HarnessName {
    if (typeof raw.hookEventName === "string") {
        return "grok";
    }

    if (typeof raw.model === "string" || /\/rollout-[0-9]/.test(String(raw.transcript_path ?? ""))) {
        return "codex";
    }

    return "claude";
}

/** Lower-cased and underscore-stripped, so `hook_event_name` and `hookEventName` agree. */
export function normalizeEvent(value: unknown): string {
    return String(value ?? "")
        .toLowerCase()
        .replace(/_/g, "");
}

/** PostToolUse: the text a shell tool printed (stdout and stderr, or the harness's single output field). */
export function toolOutputText(payload: Pick<HookPayload, "toolResponse">): string {
    const response = payload.toolResponse ?? {};
    return ["stdout", "stderr", "output"]
        .map((field) => response[field])
        .filter((value): value is string => typeof value === "string")
        .join("\n");
}

export function parseHookPayload(text: string): HookPayload | null {
    let raw: Record<string, unknown>;

    try {
        const parsed = SafeJSON.parse(text, { strict: true });

        if (typeof parsed !== "object" || parsed === null) {
            return null;
        }

        raw = parsed as Record<string, unknown>;
    } catch {
        // A hook that throws on malformed input blocks the tool call; returning null lets
        // the entrypoint exit 0 and stay out of the way.
        return null;
    }

    const harness = detectHarness(raw);
    const event = str(raw.hookEventName) ?? str(raw.hook_event_name) ?? "";
    const tool = str(raw.toolName) ?? str(raw.tool_name) ?? "";
    const input = record(raw.toolInput ?? raw.tool_input);
    const response = record(raw.toolResponse ?? raw.tool_response);
    const native = response?.bashEditDiff as { files?: { filePath?: unknown }[] } | undefined;
    const nativeDiffFiles: string[] = [];

    // `native` is a CAST, not a check. A `files` that is a number or a plain object is still
    // non-iterable, and the `for…of` would throw outside the parse `try`, so the entrypoint
    // would exit non-zero on malformed input instead of ignoring it. The same holds per
    // element: `files: [null]` threw on `.filePath`.
    for (const file of Array.isArray(native?.files) ? native.files : []) {
        const path = typeof file === "object" && file !== null ? str(file.filePath) : undefined;

        if (path) {
            nativeDiffFiles.push(path);
        }
    }

    return {
        event,
        tool,
        cwd: str(raw.cwd) ?? process.cwd(),
        sessionId: str(raw.sessionId) ?? str(raw.session_id),
        toolUseId: str(raw.toolUseId) ?? str(raw.tool_use_id),
        command: str(input?.command) ?? "",
        model: str(raw.model) ?? "",
        harness,
        nativeDiffFiles,
        transcriptPath: str(raw.transcriptPath) ?? str(raw.transcript_path),
        lastAssistantMessage: str(raw.lastAssistantMessage) ?? str(raw.last_assistant_message),
        stopHookActive: bool(raw.stopHookActive) ?? bool(raw.stop_hook_active),
        toolInput: input,
        toolResponse: response,
        notificationType: str(raw.notificationType) ?? str(raw.notification_type),
        notificationMessage: str(raw.message),
        prompt: str(raw.prompt),
        // An empty id is the main agent's, as no id is.
        agentId: (str(raw.agentId) ?? str(raw.agent_id)) || undefined,
        raw,
    };
}
