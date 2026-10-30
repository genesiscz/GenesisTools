import type { NativeCall, NativeScan, ToolTiming } from "@genesiscz/utils/ai/transcripts/insights-types";
import { eachLine } from "@genesiscz/utils/ai/transcripts/native-scan";
import { parseTranscriptLine } from "@genesiscz/utils/ai/transcripts/parse-line";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
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
