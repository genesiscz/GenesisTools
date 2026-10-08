import { statSync } from "node:fs";
import type { TranscriptAnchor } from "@genesiscz/utils/agent/source-anchor";
import type { ConversationMessage } from "@genesiscz/utils/claude/types";
import { logger } from "@genesiscz/utils/logger";
import { claudeMessagesToTurns } from "./claude";
import { codexNativeLinesToTurns } from "./codex";
import { grokNativeLinesToTurns } from "./grok";
import { parseTranscriptLine } from "./parse-line";
import type { ResolvedTranscript } from "./resolve";
import { readRange } from "./turn-index";
import { isoFromRecordTimestamp, type TranscriptTurn } from "./types";

export interface TranscriptAround {
    status: "native" | "receipt-time" | "native-not-found" | "unanchored" | "unsupported";
    detail: string;
    before: TranscriptTurn[];
    around: TranscriptTurn[];
    after: TranscriptTurn[];
    bytesRead: number;
    fileSize: number;
    truncated: boolean;
    skippedLines: number;
    anchorOffset?: number;
}

interface LocatedRecord {
    gapBefore: boolean;
    offset: number;
    value: Record<string, unknown>;
    at: number | null;
}
const DEFAULT_BYTES = 2 * 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_WINDOW_BYTES = 256 * 1024;
const MAX_RECORDS = 100;

function record(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function strings(values: unknown[]): string[] {
    return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}

function findNativeRecord({
    rows,
    anchor,
}: {
    rows: LocatedRecord[];
    anchor: Extract<TranscriptAnchor, { kind: "native" }>;
}): number {
    let activeCodexTurn: string | undefined;
    for (const [index, { value: row, gapBefore }] of rows.entries()) {
        if (gapBefore) {
            activeCodexTurn = undefined;
        }
        const payload = record(row.payload);
        const message = record(row.message);
        const update = record(record(row.params).update);
        let messageIds: string[] = [];
        let toolCallIds: string[] = [];
        let turnIds: string[] = [];
        if (anchor.provider === "claude" && ["user", "assistant"].includes(String(row.type))) {
            messageIds = strings([row.uuid, message.id]);
            const content = Array.isArray(message.content) ? message.content.map(record) : [];
            toolCallIds = strings(content.filter((part) => part.type === "tool_use").map((part) => part.id));
        } else if (anchor.provider === "codex") {
            const startsTurn =
                row.type === "turn_context" || (row.type === "event_msg" && payload.type === "task_started");
            const endsTurn = row.type === "event_msg" && payload.type === "task_complete";
            const usage = row.type === "token_usage_record";
            const directTurn = strings([payload.turn_id])[0];
            if (startsTurn) {
                activeCodexTurn = directTurn;
            }
            if (startsTurn || endsTurn || usage) {
                turnIds = strings([directTurn]);
            } else if (row.type === "response_item") {
                turnIds = [...new Set(strings([directTurn, activeCodexTurn]))];
                if (payload.type === "message") {
                    messageIds = strings([payload.id]);
                }
                if (payload.type === "function_call" || payload.type === "custom_tool_call") {
                    toolCallIds = strings([payload.call_id]);
                }
            }
            if (endsTurn && directTurn === activeCodexTurn) {
                activeCodexTurn = undefined;
            }
        } else if (anchor.provider === "grok") {
            messageIds = strings([update.messageId]);
            turnIds = strings([update.turnId]);
            if (update.sessionUpdate === "tool_call") {
                toolCallIds = strings([update.toolCallId]);
            }
        }
        // Every supplied identity must be supported at this record. A broad turn match cannot
        // substitute for a missing tool/message ID, and contradictory enclosing turns are rejected.
        if (
            (!anchor.toolCallId || toolCallIds.includes(anchor.toolCallId)) &&
            (!anchor.messageId || messageIds.includes(anchor.messageId)) &&
            (!anchor.turnId || (turnIds.length > 0 && turnIds.every((id) => id === anchor.turnId)))
        ) {
            return index;
        }
    }
    return -1;
}

function claudeMessage(value: Record<string, unknown>): value is Record<string, unknown> & ConversationMessage {
    const message = record(value.message);
    if (typeof value.uuid !== "string" || !["user", "assistant"].includes(String(value.type))) {
        return false;
    }
    if (value.type === "user" && typeof message.content === "string") {
        return true;
    }
    return Array.isArray(message.content) && message.content.every((part) => typeof record(part).type === "string");
}

function turns({
    records,
    resolved,
    toolCallId,
}: {
    records: LocatedRecord[];
    resolved: ResolvedTranscript;
    toolCallId?: string;
}): { turns: TranscriptTurn[]; truncated: boolean } {
    const values = records.map((item) => item.value);
    const result =
        resolved.provider === "claude"
            ? claudeMessagesToTurns(values.filter(claudeMessage))
            : resolved.provider === "codex"
              ? codexNativeLinesToTurns(values)
              : grokNativeLinesToTurns(values);
    const truncated = result.some(
        (turn) => turn.text.length > 8_000 || (turn.reasoning?.length ?? 0) > 2_000 || turn.tools.length > 12
    );
    return {
        truncated,
        turns: result.map((turn) => ({
            ...turn,
            // This is presentation identity within a byte window, never a native source ID.
            id: `${records[0]?.offset ?? 0}:${turn.id}`,
            text: turn.text.slice(0, 8_000),
            reasoning: turn.reasoning?.slice(0, 2_000),
            tools:
                toolCallId && turn.tools.length > 12
                    ? [
                          ...turn.tools.filter((tool) => tool.id === toolCallId),
                          ...turn.tools.filter((tool) => tool.id !== toolCallId),
                      ].slice(0, 12)
                    : turn.tools.slice(0, 12),
        })),
    };
}

/** Reads a bounded, complete-line tail window. It never builds a whole-file index or normalizes ordinal IDs as anchors. */
export function transcriptAround({
    resolved,
    anchor,
    maxBytes = DEFAULT_BYTES,
    radius = 40,
    before: beforeCount = 2,
    after: afterCount = 2,
    signal,
}: {
    resolved: ResolvedTranscript;
    anchor: TranscriptAnchor;
    maxBytes?: number;
    radius?: number;
    before?: number;
    after?: number;
    signal?: AbortSignal;
}): TranscriptAround {
    for (const count of [beforeCount, afterCount]) {
        if (!Number.isInteger(count) || count < 0 || count > 10) {
            throw new Error("Context before/after counts must be integers between 0 and 10");
        }
    }
    const result: TranscriptAround = {
        status: "unanchored",
        detail: "No source session or native anchor was recorded.",
        before: [],
        around: [],
        after: [],
        bytesRead: 0,
        fileSize: 0,
        truncated: false,
        skippedLines: 0,
    };
    signal?.throwIfAborted();
    if (anchor.kind === "unanchored") {
        return result;
    }
    if (anchor.provider !== resolved.provider || anchor.sessionId !== resolved.sessionId) {
        throw new Error("The receipt and transcript have different provider/session identities");
    }
    if (resolved.source !== "native" || !["claude", "codex", "grok"].includes(resolved.provider)) {
        return {
            ...result,
            status: "unsupported",
            detail: "Receipt context currently supports native Claude, Codex and Grok transcripts.",
        };
    }
    const size = statSync(resolved.filePath).size;
    const budget = Math.max(1, Math.min(8 * 1024 * 1024, Math.floor(maxBytes)));
    const start = Math.max(0, size - budget);
    const buffer = readRange(resolved.filePath, start, size);
    result.bytesRead = buffer.length;
    result.fileSize = size;
    result.truncated = start > 0;
    let cursor = start > 0 ? buffer.indexOf(10) + 1 : 0;
    if (start > 0 && cursor === 0) {
        result.skippedLines += 1;
        cursor = buffer.length;
    }
    const rows: LocatedRecord[] = [];
    let gapBefore = false;
    while (cursor < buffer.length) {
        signal?.throwIfAborted();
        const end = buffer.indexOf(10, cursor);
        if (end < 0) {
            result.skippedLines += 1;
            break;
        }
        if (end - cursor > MAX_LINE_BYTES) {
            gapBefore = true;
            result.skippedLines += 1;
            cursor = end + 1;
            continue;
        }
        const value = parseTranscriptLine(buffer.toString("utf8", cursor, end));
        if (value) {
            const rawAt = value.timestamp;
            const at =
                typeof rawAt === "number"
                    ? Date.parse(isoFromRecordTimestamp(rawAt) ?? "")
                    : typeof rawAt === "string"
                      ? Date.parse(rawAt)
                      : NaN;
            rows.push({ offset: start + cursor, value, at: Number.isFinite(at) ? at : null, gapBefore });
            gapBefore = false;
        } else {
            gapBefore = true;
            result.skippedLines += 1;
        }
        cursor = end + 1;
    }
    let selected = anchor.kind === "native" ? findNativeRecord({ rows, anchor }) : -1;
    const exact = selected >= 0;
    if (selected < 0) {
        let distance = Infinity;
        for (const [index, row] of rows.entries()) {
            if (row.at !== null && Math.abs(row.at - anchor.receivedAt) < distance) {
                selected = index;
                distance = Math.abs(row.at - anchor.receivedAt);
            }
        }
    }
    result.status = exact ? "native" : anchor.kind === "native" ? "native-not-found" : "receipt-time";
    result.detail = exact
        ? "Matched all supplied native source IDs."
        : anchor.kind === "native"
          ? "Not all supplied native source IDs could be verified in the scanned window. Nearby receipt-time context is shown when available."
          : "No native source ID was supplied. This is the nearest recorded time within the scanned window, not an exact message match.";
    if (selected >= 0) {
        const count = Math.min(MAX_RECORDS, Math.max(1, Math.floor(radius)));
        const anchorRow = rows[selected];
        const before = rows
            .slice(Math.max(0, selected - count), selected)
            .filter((row) => anchorRow.offset - row.offset <= MAX_WINDOW_BYTES / 2);
        const after = rows
            .slice(selected + 1, selected + count + 1)
            .filter((row) => row.offset - anchorRow.offset <= MAX_WINDOW_BYTES / 2);
        result.anchorOffset = anchorRow.offset;
        const rendered = turns({
            records: [...before, anchorRow, ...after],
            resolved,
            toolCallId: anchor.kind === "native" ? anchor.toolCallId : undefined,
        });
        const window = rendered.turns;
        result.truncated ||= rendered.truncated;
        let turnIndex =
            anchor.kind === "native" && anchor.toolCallId
                ? window.findIndex((turn) => turn.tools.some((tool) => tool.id === anchor.toolCallId))
                : -1;
        if (turnIndex < 0 && anchor.kind === "native" && anchor.messageId && resolved.provider === "claude") {
            const uuid = anchorRow.value.uuid;
            turnIndex = window.findIndex((turn) => typeof uuid === "string" && turn.id.endsWith(`:${uuid}`));
        }
        if (turnIndex < 0) {
            let nearest = Infinity;
            for (const [index, turn] of window.entries()) {
                const delta = Math.abs(Date.parse(turn.at ?? "") - (anchorRow.at ?? anchor.receivedAt));
                if (delta < nearest) {
                    turnIndex = index;
                    nearest = delta;
                }
            }
        }
        result.before =
            turnIndex < 0 || beforeCount === 0 ? [] : window.slice(Math.max(0, turnIndex - beforeCount), turnIndex);
        result.around = turnIndex < 0 ? [] : window.slice(turnIndex, turnIndex + 1);
        result.after =
            afterCount === 0 ? [] : window.slice(Math.max(0, turnIndex + 1), Math.max(0, turnIndex + 1) + afterCount);
        result.truncated ||= result.before.length + result.around.length + result.after.length < window.length;
        result.truncated ||= before.length < selected || selected + 1 + after.length < rows.length;
    }
    result.truncated ||= result.skippedLines > 0;
    logger.debug(
        {
            path: resolved.filePath,
            bytesRead: result.bytesRead,
            status: result.status,
            skippedLines: result.skippedLines,
        },
        "Receipt transcript window read"
    );
    return result;
}
