import { copilotHost } from "@genesiscz/utils/agent/hosts/copilot";
import type { HookCallerFacts } from "@genesiscz/utils/agent/identity/types";
import { byHarness, isAccountProviderAlias, type PerHarness } from "@genesiscz/utils/ai/providers/alias-list";
import { harnessHooks } from "@genesiscz/utils/ai/providers/harness-hooks";
import type { HookFacts } from "@genesiscz/utils/harness/parts";
import { SafeJSON } from "@genesiscz/utils/json";
import { profiler } from "@genesiscz/utils/profile";
import { HARNESS_NAMES, type HarnessName } from "./config";

const prof = profiler.scope("agent-context");

export interface HookPayload {
    event: string;
    tool: string;
    cwd: string;
    sessionId?: string;
    toolUseId?: string;
    command: string;
    model: string;
    /**
     * The hook dialect: which harness's spelling and rules the payload follows. A Copilot payload keeps the dialect
     * of its spelling (Copilot has no hooks config of its own); who sent it is `caller`.
     */
    harness: HarnessName;
    /** Who ran the hook: the harness, or `copilot`, the host that is no harness of ours. */
    caller: HarnessName | "copilot";
    /** The turn the call belongs to, in the field the harness names it (Codex `turn_id`, Grok `promptId`). */
    turnId?: string;
    /** Files the harness's own renderer already drew, so we do not double-print them. */
    nativeDiffFiles: string[];
    /**
     * The typed hook fields. Every hook reads them here, never `raw.transcript_path` in a feature (lint-rules
     * `no-hook-payload-read`): a harness that spells a field another way is one line in `parseHookPayload`.
     */
    transcriptPath?: string;
    /**
     * SubagentStop: the subagent's own transcript (Claude's `agent_transcript_path`). A subagent's other events name
     * only the main session's `transcriptPath`.
     */
    agentTranscriptPath?: string;
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

/** The harness of each spelling, first in driver order: snake_case is Claude's, camelCase Grok's. */
function harnessSpelling(spelling: "snake_case" | "camelCase"): HarnessName {
    return HARNESS_NAMES.find((name) => HARNESS_HOOK_FACTS[name].payload.spelling === spelling) ?? HARNESS_NAMES[0];
}

function eventName(raw: Record<string, unknown>): string {
    return str(raw.hookEventName) ?? str(raw.hook_event_name) ?? "";
}

/** Lower camelCase (`subagentStop`, `postToolUse`): a lower-case word, then a capital. Grok's `session_start` is not. */
const LOWER_CAMEL_EVENT = /^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/;

/**
 * Copilot by its own marks (its `HostPayloadMarkers`): a parent agent id, an event named in lower camelCase, or an
 * epoch-millisecond timestamp. Its camelCase payloads used to read as Grok and its snake_case ones as Claude.
 */
function isCopilotPayload(raw: Record<string, unknown>): boolean {
    const marks = copilotHost.payload;

    return (
        marks.markerFields.some((field) => raw[field] !== undefined) ||
        (marks.lowerCamelEvents && LOWER_CAMEL_EVENT.test(eventName(raw))) ||
        (marks.numericTimestamp && typeof raw.timestamp === "number")
    );
}

/**
 * The harness a payload's dialect names, from the drivers' `HookPayloadDialect` facts, in this order: a transcript
 * path only one harness writes; a null transcript (Codex documents it nullable); the camelCase spelling; a `model` on
 * an event where only a harness that sends it on every event would (Claude names it on SessionStart, so a Claude
 * SessionStart with a model is Claude, not Codex); else the snake_case harness.
 */
function dialectOf(raw: Record<string, unknown>): HarnessName {
    const transcript = raw.transcriptPath ?? raw.transcript_path;
    const byTranscript = HARNESS_NAMES.find((name) => {
        const pattern = HARNESS_HOOK_FACTS[name].payload.transcriptName;
        return typeof transcript === "string" && pattern?.test(transcript);
    });

    if (byTranscript) {
        return byTranscript;
    }

    const nullable = HARNESS_NAMES.find((name) => HARNESS_HOOK_FACTS[name].payload.nullTranscript);

    if (
        nullable &&
        (Object.hasOwn(raw, "transcript_path") || Object.hasOwn(raw, "transcriptPath")) &&
        transcript === null
    ) {
        return nullable;
    }

    if (typeof raw.hookEventName === "string") {
        return harnessSpelling("camelCase");
    }

    if (typeof raw.model === "string") {
        const event = eventName(raw);
        const named = HARNESS_NAMES.find((name) => {
            const events = HARNESS_HOOK_FACTS[name].payload.modelEvents;
            return events !== "every" && events.includes(event);
        });
        const everywhere = HARNESS_NAMES.find(
            (name) =>
                HARNESS_HOOK_FACTS[name].payload.modelEvents === "every" &&
                HARNESS_HOOK_FACTS[name].payload.spelling === "snake_case"
        );

        return named ?? everywhere ?? harnessSpelling("snake_case");
    }

    return harnessSpelling("snake_case");
}

/**
 * Read from the PAYLOAD, never from the environment: a Codex worker spawned from a Claude session inherits every
 * CLAUDE_CODE_* variable. The answer is the hook dialect (`HookPayload.harness`); a Copilot payload keeps the dialect
 * of its spelling, and `detectHookCaller` names Copilot itself.
 */
export function detectHarness(raw: Record<string, unknown>): HarnessName {
    return isCopilotPayload(raw)
        ? harnessSpelling(typeof raw.hookEventName === "string" ? "camelCase" : "snake_case")
        : dialectOf(raw);
}

/** Who ran the hook: the harness of its dialect, or Copilot by its own marks. */
export function detectHookCaller(raw: Record<string, unknown>): HarnessName | "copilot" {
    return isCopilotPayload(raw) ? "copilot" : dialectOf(raw);
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
    return prof.measure("hooks.parseHookPayload", () => readHookPayload(text));
}

function readHookPayload(text: string): HookPayload | null {
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
    const caller = detectHookCaller(raw);
    const turnField = caller === "copilot" ? null : HARNESS_HOOK_FACTS[caller].payload.turnIdField;
    const subagentFields =
        caller === "copilot"
            ? copilotHost.payload.subagentIdFields
            : ["agentId", "agent_id", HARNESS_HOOK_FACTS[caller].payload.subagentIdField ?? ""].filter(Boolean);
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
        caller,
        ...(turnField && str(raw[turnField]) ? { turnId: str(raw[turnField]) } : {}),
        nativeDiffFiles,
        transcriptPath: str(raw.transcriptPath) ?? str(raw.transcript_path),
        agentTranscriptPath: str(raw.agentTranscriptPath) ?? str(raw.agent_transcript_path),
        lastAssistantMessage: str(raw.lastAssistantMessage) ?? str(raw.last_assistant_message),
        stopHookActive: bool(raw.stopHookActive) ?? bool(raw.stop_hook_active),
        toolInput: input,
        toolResponse: response,
        notificationType: str(raw.notificationType) ?? str(raw.notification_type),
        notificationMessage: str(raw.message),
        prompt: str(raw.prompt),
        // An empty id is the main agent's, as no id is.
        agentId: subagentFields.map((field) => str(raw[field])).find(Boolean) || undefined,
        raw,
    };
}

/**
 * The transcript of the agent that made the call. A subagent's payload names the MAIN session's `transcript_path`, so
 * its own is the payload's `agent_transcript_path` (SubagentStop) or the file its harness keeps beside the session
 * (`HookFacts.subagentTranscript`); where the harness names none, the payload's path stands as it is.
 */
function callerTranscriptPath(payload: HookPayload): string | undefined {
    const lead = payload.transcriptPath || undefined;

    if (!payload.agentId || payload.agentTranscriptPath) {
        return payload.agentTranscriptPath || lead;
    }

    const own =
        lead && payload.caller !== "copilot"
            ? HARNESS_HOOK_FACTS[payload.caller].subagentTranscript(lead, payload.agentId)
            : null;
    return own ?? lead;
}

/**
 * What the payload says about its caller, for the agent identity module (`whoIsCalling({ origin: "local", env, hook
 * })`). The cwd is the payload's own, never the `process.cwd()` fallback of `HookPayload.cwd`, and a subagent's
 * transcript is its own (`callerTranscriptPath`), so its model is never its parent's.
 */
export function hookCallerFacts(payload: HookPayload): HookCallerFacts {
    return {
        caller: payload.caller,
        sessionId: payload.sessionId || undefined,
        toolUseId: payload.toolUseId || undefined,
        subagentId: payload.agentId,
        turnId: payload.turnId,
        model: payload.model || undefined,
        transcriptPath: callerTranscriptPath(payload),
        cwd: str(payload.raw.cwd) || undefined,
    };
}
