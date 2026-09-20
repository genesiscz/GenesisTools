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
    raw: Record<string, unknown>;
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
    const input = (raw.toolInput ?? raw.tool_input) as { command?: unknown } | undefined;
    const response = (raw.toolResponse ?? raw.tool_response) as Record<string, unknown> | undefined;
    const native = response?.bashEditDiff as { files?: { filePath?: unknown }[] } | undefined;
    const nativeDiffFiles: string[] = [];

    // `native` is a CAST, not a check. A `files` that is a number or a plain object is still
    // non-iterable, and the `for…of` would throw outside the parse `try`, so the entrypoint
    // would exit non-zero on malformed input instead of ignoring it.
    for (const file of Array.isArray(native?.files) ? native.files : []) {
        const path = str(file.filePath);

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
        raw,
    };
}
