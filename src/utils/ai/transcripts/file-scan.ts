/**
 * Byte-level scans over a whole transcript, for the few facts a list row needs that no head or
 * tail slice holds: how many tool calls an agent made, which Agent calls it started, and the
 * `<task-notification>` statuses a parent received.
 *
 * The file is read in fixed chunks and searched with `Buffer.indexOf`, never split into lines or
 * parsed as JSON. Measured 2026-10-01 on one session's 41 sub-agent files (162 MB): 25 ms warm,
 * 46 ms cold, which is why a list may afford it where a JSON parse of the same bytes would not.
 *
 * The needles match raw JSON bytes. A needle quoted inside a string value is escaped there
 * (`\"type\":\"tool_use\"`), so text that merely mentions a tool call is not counted as one.
 */
import { closeSync, openSync, readSync } from "node:fs";
import { logger } from "@genesiscz/utils/logger";

const CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Calls `onMatch` once per occurrence of `needle`, with the bytes from the match to at most
 * `window` bytes after it (less at the end of the file). Returns false when the file is unreadable.
 */
export function scanFileMatches(
    path: string,
    needle: string,
    window: number,
    onMatch: (slice: Buffer) => void
): boolean {
    const pattern = Buffer.from(needle);
    const span = Math.max(window, pattern.length);
    const buffer = Buffer.alloc(CHUNK_BYTES + span);
    let fd: number | null = null;

    try {
        fd = openSync(path, "r");
        let carried = 0;
        let position = 0;

        for (;;) {
            const read = readSync(fd, buffer, carried, CHUNK_BYTES, position);
            position += read;
            const end = carried + read;
            const done = read === 0;
            // A match that starts inside the last `span` bytes may run past this chunk: it is
            // carried into the next read instead, so it is reported exactly once and whole.
            const limit = done ? end : Math.max(0, end - span);
            const view = buffer.subarray(0, end);
            let index = view.indexOf(pattern);

            while (index !== -1 && index < limit) {
                onMatch(view.subarray(index, Math.min(end, index + span)));
                index = view.indexOf(pattern, index + pattern.length);
            }

            if (done) {
                return true;
            }

            buffer.copy(buffer, 0, limit, end);
            carried = end - limit;
        }
    } catch (error) {
        logger.debug({ error, path }, "[transcripts] file scan failed");
        return false;
    } finally {
        if (fd !== null) {
            closeSync(fd);
        }
    }
}

export interface ToolCallScan {
    toolCalls: number;
    /** The `tool_use` ids of the Agent (or legacy Task) calls, in file order: the agents it started. */
    agentCalls: string[];
}

const CLAUDE_TOOL_USE = '"type":"tool_use","id":"';
const CLAUDE_AGENT_CALL = /^"type":"tool_use","id":"([^"]+)","name":"(?:Agent|Task)"/;

/** Tool calls in a Claude transcript, and which of them started an agent. Null when unreadable. */
export function scanClaudeToolCalls(path: string): ToolCallScan | null {
    const scan: ToolCallScan = { toolCalls: 0, agentCalls: [] };
    const ok = scanFileMatches(path, CLAUDE_TOOL_USE, 160, (slice) => {
        scan.toolCalls++;
        const agent = CLAUDE_AGENT_CALL.exec(slice.toString("latin1"));
        if (agent) {
            scan.agentCalls.push(agent[1]);
        }
    });
    return ok ? scan : null;
}

const CODEX_ITEM_STARTED = '"method":"item/started","params":{"item":{"type":"';
/** Items a codex turn produces that are not tool calls. */
const CODEX_NON_TOOL_ITEMS = new Set(["userMessage", "agentMessage", "reasoning"]);

/** Tool calls in a `tools codex` worker's event log (`<name>.jsonl`). Null when unreadable. */
export function scanCodexWorkerToolCalls(path: string): number | null {
    let count = 0;
    const ok = scanFileMatches(path, CODEX_ITEM_STARTED, CODEX_ITEM_STARTED.length + 40, (slice) => {
        const type = /^[A-Za-z]+/.exec(slice.subarray(CODEX_ITEM_STARTED.length).toString("latin1"))?.[0];
        if (type && !CODEX_NON_TOOL_ITEMS.has(type)) {
            count++;
        }
    });
    return ok ? count : null;
}

/** Tool calls in a grok turn file (`<name>.turn<N>.jsonl`, ACP updates). Null when unreadable. */
export function scanGrokToolCalls(path: string): number | null {
    let count = 0;
    const ok = scanFileMatches(path, '"type":"tool_call","', 32, () => {
        count++;
    });
    return ok ? count : null;
}

export interface TaskNotification {
    /** For an agent, its id (`a0564…`); for a background shell, the task id. */
    taskId: string;
    toolUseId: string | null;
    /** `completed`, `failed`, `killed`, … as Claude Code wrote it. */
    status: string;
}

// The JSON-escaped newline between the tags is a literal backslash and `n` in the file.
const NOTIFICATION = "<task-notification>\\n<task-id>";
const NOTIFICATION_WINDOW = 1500;

/**
 * The last `<task-notification>` status per task id in a parent transcript, in file order, so a
 * later notification for the same task wins. A notification with no `<status>` (a Monitor event)
 * is skipped.
 */
export function readTaskNotifications(path: string): Map<string, TaskNotification> {
    const notifications = new Map<string, TaskNotification>();
    scanFileMatches(path, NOTIFICATION, NOTIFICATION_WINDOW, (slice) => {
        const text = slice.toString("utf8");
        const close = text.indexOf("</task-notification>");
        const body = close === -1 ? text : text.slice(0, close);
        const taskId = /<task-id>([^<]+)<\/task-id>/.exec(body)?.[1];
        const status = /<status>([^<]+)<\/status>/.exec(body)?.[1];
        if (!taskId || !status) {
            return;
        }

        const toolUseId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(body)?.[1] ?? null;
        notifications.set(taskId, { taskId, toolUseId, status });
    });
    return notifications;
}
