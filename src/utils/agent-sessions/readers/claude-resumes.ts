import { isObject } from "@genesiscz/utils/object";
import type {
    LoopResumes,
    PauseCause,
    SessionLoop,
    SessionPause,
    TimedSessionCall,
    WrittenLifetime,
} from "../analysis-types";
import { isoOf } from "./analysis-lines";
import { claudeCall, contextAfter, isCompactBoundary, type LoopCollector } from "./claude-analysis-loops";

const priority: Record<PauseCause, number> = { unknown: 0, tool: 1, notification: 2, message: 3 };

function delivery(row: Record<string, unknown>): PauseCause | null {
    if (row.type === "attachment" && isObject(row.attachment) && row.attachment.type === "queued_command") {
        const origin = row.attachment.origin;
        return isObject(origin) && origin.kind === "task-notification" ? "notification" : "message";
    }

    if (row.type !== "user" || !isObject(row.message)) {
        return null;
    }

    const content = row.message.content;
    const parts = Array.isArray(content) ? content : [content];
    if (parts.some((part) => isObject(part) && part.type === "tool_result")) {
        return "tool";
    }

    const notification = parts.some((part) => {
        const text = isObject(part) ? part.text : part;
        return typeof text === "string" && text.includes("<task-notification>");
    });
    return notification ? "notification" : "message";
}

function writtenLifetime(
    call: { cacheWrite: number; cacheWrite1h?: number },
    message: Record<string, unknown>
): WrittenLifetime {
    if (!call.cacheWrite || !isObject(message.usage) || !isObject(message.usage.cache_creation)) {
        return "none";
    }
    if (!call.cacheWrite1h) {
        return "5m";
    }
    return call.cacheWrite1h === call.cacheWrite ? "1h" : "mixed";
}

export function collectResumes(loop: SessionLoop): LoopCollector<LoopResumes> {
    const calls: TimedSessionCall[] = [];
    const pauses: SessionPause[] = [];
    const seen = new Set<string>();
    let start: string | null = null;
    let cause: PauseCause = "unknown";
    let compacted = false;
    let lastWrite: WrittenLifetime = "none";

    return {
        visit({ row }) {
            if (isCompactBoundary(row)) {
                compacted = true;
                return;
            }

            const at = isoOf(row.timestamp);
            if (!at) {
                return;
            }

            const nextCause = delivery(row);
            if (nextCause) {
                start = at;
                if (priority[nextCause] > priority[cause]) {
                    cause = nextCause;
                }
                return;
            }

            if (row.type !== "assistant" || !isObject(row.message)) {
                return;
            }

            const previous = calls.at(-1);
            const stop = typeof row.message.stop_reason === "string" ? row.message.stop_reason : null;
            if (previous && row.message.id === previous.id) {
                previous.end = at;
                previous.stop = stop ?? previous.stop;
                return;
            }

            const usage = claudeCall(row);
            if (!usage || seen.has(usage.id)) {
                return;
            }

            const call = { ...usage, start: start ?? at, end: at, stop, writeTtl: writtenLifetime(usage, row.message) };
            if (previous) {
                const expected = contextAfter(previous);
                const share = expected > 0 ? call.cacheRead / expected : 0;
                const outcome = share >= 0.9 ? "hit" : share <= 0.1 ? "miss" : "partial";
                const modelChanged = call.model !== previous.model;
                pauses.push({
                    callId: call.id,
                    at,
                    model: call.model,
                    gapMs: Math.max(0, Date.parse(call.start) - Date.parse(previous.end)),
                    resumed: previous.stop === "end_turn",
                    cause,
                    compacted,
                    modelChanged,
                    expected,
                    cacheRead: call.cacheRead,
                    cacheWrite: call.cacheWrite,
                    writeTtl: lastWrite,
                    outcome,
                    rewrittenTokens: Math.min(call.cacheWrite, Math.max(0, expected - call.cacheRead)),
                });
                if (compacted || modelChanged) {
                    lastWrite = "none";
                }
            }

            if (call.cacheWrite > 0) {
                lastWrite = call.writeTtl;
            }

            seen.add(call.id);
            calls.push(call);
            start = null;
            cause = "unknown";
            compacted = false;
        },
        finish: () => ({ ...loop, calls, pauses }),
    };
}
