import { isObject } from "@genesiscz/utils/object";
import { type PendingCallShape, pendingCallDetail } from "../pending-call";
import type { PendingToolCall } from "../types";

/** Grok tool kinds (`_meta["x.ai/tool"].kind`) and names by the shape of their input. */
const GROK_KIND_SHAPES: Readonly<Record<string, PendingCallShape>> = {
    execute: "command",
    edit: "replace",
    exit_plan: "plan",
};

const GROK_NAME_SHAPES: Readonly<Record<string, PendingCallShape>> = {
    write_file: "write",
    create_file: "write",
};

/** Statuses that end a Grok call; `pending` and `in_progress` are progress. */
const GROK_DONE: ReadonlySet<string> = new Set(["completed", "failed"]);

/**
 * The newest open `tool_call` of an `updates.jsonl` tail: Grok writes the call (with `rawInput`) before its permission
 * prompt, and a `tool_call_update` with a terminal status only after the answer. Its `events.jsonl` permission records
 * name only the tool, so the call input comes from here.
 */
export function grokPendingCall(records: readonly Record<string, unknown>[]): PendingToolCall | null {
    const open = new Map<string, PendingToolCall>();

    for (const record of records) {
        const params = isObject(record.params) ? record.params : null;
        const update = params && isObject(params.update) ? params.update : null;
        const callId = typeof update?.toolCallId === "string" ? update.toolCallId : null;

        if (!update || !callId) {
            continue;
        }

        if (update.sessionUpdate === "tool_call") {
            const meta = isObject(update._meta) && isObject(update._meta["x.ai/tool"]) ? update._meta["x.ai/tool"] : {};
            const name =
                typeof meta.name === "string" ? meta.name : typeof update.title === "string" ? update.title : "tool";
            const kind = typeof meta.kind === "string" ? meta.kind : "";
            const shape = GROK_NAME_SHAPES[name] ?? GROK_KIND_SHAPES[kind] ?? GROK_KIND_SHAPES[name] ?? "tool";
            open.delete(callId);
            open.set(callId, {
                callId,
                tool: name,
                ...(typeof record.timestamp === "string" ? { at: record.timestamp } : {}),
                detail: pendingCallDetail(shape, update.rawInput),
            });
        } else if (
            update.sessionUpdate === "tool_call_update" &&
            typeof update.status === "string" &&
            GROK_DONE.has(update.status)
        ) {
            open.delete(callId);
        }
    }

    return [...open.values()].at(-1) ?? null;
}
