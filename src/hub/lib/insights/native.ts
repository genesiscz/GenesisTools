import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { TranscriptProvider } from "@genesiscz/utils/ai/transcripts";
import { parseTranscriptLine } from "@genesiscz/utils/ai/transcripts/parse-line";
import { SafeJSON } from "@genesiscz/utils/json";
import type { NativeCall, NativeScan, ToolTiming } from "./types";

// The provider's own session file, for what `tools ai sessions tail` turns leave out: per-call
// usage with cache writes and the model (Claude turns carry no usage at all), exact tool timing
// (the tool_result line's timestamp), and each call's full input for the stuck detector's
// "same call again" test. Mirrors the hub's Swift `SessionNativeLog` scan, which reads the same
// fields for the rows it draws.

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** `claude-opus-5-5` → `opus`: the family word the session list and the transcript use. */
export function shortModel(model: string): string {
    for (const family of ["fable", "opus", "sonnet", "haiku"]) {
        if (model.includes(family)) {
            return family;
        }
    }

    return model.startsWith("claude-") ? model.slice(7) : model;
}

/** Calls `visit` for each line of `text`, without splitting the whole file into an array first. */
function eachLine(text: string, visit: (line: string) => void): void {
    let start = 0;

    while (start < text.length) {
        const newline = text.indexOf("\n", start);
        const end = newline === -1 ? text.length : newline;

        if (end > start) {
            visit(text.slice(start, end));
        }

        start = end + 1;
    }
}

function isConversationLine(line: string): boolean {
    return line.includes('"type":"assistant"') || line.includes('"type":"user"');
}

/**
 * One pass over a Claude session file. Only conversation lines are parsed (a byte search skips
 * snapshots and attachments first). A message split over several lines (one per content block)
 * shares one `message.id` and one usage record, counted once at its first line. Sub-agent lines
 * (`isSidechain`) belong to another conversation and are skipped.
 */
export function scanClaudeNative(text: string): NativeScan {
    const scan: NativeScan = { ordinals: new Map(), calls: [], toolTimings: new Map(), cwd: null, branch: null };
    const seenMessages = new Set<string>();
    let ordinal = 0;

    eachLine(text, (line) => {
        if (!isConversationLine(line)) {
            return;
        }

        const record = parseTranscriptLine(line);

        if (!record || record.isSidechain === true) {
            return;
        }

        ordinal += 1;
        const uuid = typeof record.uuid === "string" ? record.uuid : null;
        const at = typeof record.timestamp === "string" ? record.timestamp : null;

        if (uuid) {
            scan.ordinals.set(uuid, ordinal);
        }

        if (typeof record.cwd === "string" && record.cwd) {
            scan.cwd = record.cwd;
        }

        if (typeof record.gitBranch === "string" && record.gitBranch) {
            scan.branch = record.gitBranch;
        }

        const message = isRecord(record.message) ? record.message : null;

        if (!message) {
            return;
        }

        const content = Array.isArray(message.content) ? message.content.filter(isRecord) : [];

        if (record.type === "assistant") {
            const id = typeof message.id === "string" ? message.id : null;

            if (id && !seenMessages.has(id)) {
                seenMessages.add(id);
                const usage = isRecord(message.usage) ? message.usage : {};
                const call: NativeCall = {
                    ordinal,
                    messageId: id,
                    model: typeof message.model === "string" && message.model !== "<synthetic>" ? message.model : null,
                    at,
                    input: count(usage.input_tokens),
                    output: count(usage.output_tokens),
                    cacheRead: count(usage.cache_read_input_tokens),
                    cacheWrite: count(usage.cache_creation_input_tokens),
                    reasoning: 0,
                };
                scan.calls.push(call);
            }

            for (const block of content) {
                if (block.type === "tool_use" && typeof block.id === "string") {
                    const timing: ToolTiming = scan.toolTimings.get(block.id) ?? { startedAt: null, endedAt: null };
                    timing.startedAt = at;
                    scan.toolTimings.set(block.id, timing);
                }
            }

            return;
        }

        for (const block of content) {
            if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
                const timing: ToolTiming = scan.toolTimings.get(block.tool_use_id) ?? {
                    startedAt: null,
                    endedAt: null,
                };
                timing.endedAt = at;
                scan.toolTimings.set(block.tool_use_id, timing);
            }
        }
    });

    return scan;
}

/**
 * Tool call id → its full input as one string, for the calls in `text` (a session file or its
 * tail). The transcript's `inputPreview` is only the key argument (an Edit's path), so five
 * different edits of one file would read as one call repeated five times.
 */
export function toolInputKeys(text: string, provider: TranscriptProvider): Map<string, string> {
    const keys = new Map<string, string>();

    eachLine(text, (line) => {
        if (provider === "claude") {
            if (!line.includes('"tool_use"')) {
                return;
            }

            const record = parseTranscriptLine(line);
            const message = record && isRecord(record.message) ? record.message : null;
            const content = message && Array.isArray(message.content) ? message.content.filter(isRecord) : [];

            for (const block of content) {
                if (block.type === "tool_use" && typeof block.id === "string") {
                    keys.set(block.id, SafeJSON.stringify(block.input ?? null, { strict: true }) ?? "");
                }
            }

            return;
        }

        if (provider === "codex") {
            if (!line.includes('"call_id"')) {
                return;
            }

            const record = parseTranscriptLine(line);
            const payload = record && isRecord(record.payload) ? record.payload : null;

            if (
                payload &&
                (payload.type === "function_call" || payload.type === "custom_tool_call") &&
                typeof payload.call_id === "string"
            ) {
                const input = payload.arguments ?? payload.input ?? null;
                keys.set(
                    payload.call_id,
                    typeof input === "string" ? input : (SafeJSON.stringify(input, { strict: true }) ?? "")
                );
            }
        }
    });

    return keys;
}

/** The model a Codex rollout ran with: the last `turn_context` line's `model`. */
export function codexModelOf(text: string): string | null {
    let model: string | null = null;

    eachLine(text, (line) => {
        if (!line.includes('"turn_context"')) {
            return;
        }

        const record = parseTranscriptLine(line);
        const payload = record && isRecord(record.payload) ? record.payload : null;

        if (payload && typeof payload.model === "string" && payload.model) {
            model = payload.model;
        }
    });

    return model;
}

/** The last `bytes` of a file as text, starting at a line boundary. Throws when the file cannot be read. */
export function readTail(path: string, bytes: number): string {
    const fd = openSync(path, "r");

    try {
        const size = fstatSync(fd).size;
        const start = Math.max(0, size - bytes);
        const buffer = Buffer.alloc(size - start);
        readSync(fd, buffer, 0, buffer.length, start);
        const text = buffer.toString("utf8");

        if (start === 0) {
            return text;
        }

        const firstNewline = text.indexOf("\n");
        return firstNewline === -1 ? "" : text.slice(firstNewline + 1);
    } finally {
        closeSync(fd);
    }
}
