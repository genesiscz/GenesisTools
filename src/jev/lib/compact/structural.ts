import { measureBytes, serializeMessage } from "./format";
import { type CompactDecision, type CompactMessage, type CompactResult, isToolResult } from "./schema";

export interface StructuralCompactOptions {
    keep: number;
    pin: number;
    maxResult: number;
    threshold: number;
}

export function pinTail(messages: CompactMessage[], pin: number): CompactMessage[] {
    const cutoff = Math.max(0, messages.length - pin);
    return messages.map((message, index) => ({ ...message, pinned: index >= cutoff }));
}

export function compactStructural(messages: CompactMessage[], options: StructuralCompactOptions): CompactResult {
    const pinned = pinTail(messages, options.pin);
    const originalLines = pinned.map((message) => serializeMessage(message));
    const inBytes = measureBytes(originalLines);
    const decisions: CompactDecision[] = [];
    const kept: CompactMessage[] = [];

    const toolCounts = new Map<string, number>();
    for (const message of pinned) {
        if (isToolResult(message) && message.toolName) {
            toolCounts.set(message.toolName, (toolCounts.get(message.toolName) ?? 0) + 1);
        }
    }

    const seenTools = new Map<string, number>();
    for (const message of pinned) {
        if (message.pinned || message.roleKind === "user" || message.roleKind === "assistant") {
            kept.push(message);
            decisions.push({
                index: message.index,
                kind: "keep",
                reason: message.pinned ? "pinned" : "verbatim_text",
                toolName: message.toolName,
            });
            continue;
        }

        if (!isToolResult(message)) {
            kept.push(message);
            decisions.push({ index: message.index, kind: "keep", reason: "non_tool" });
            continue;
        }

        const name = message.toolName ?? "tool";
        const seen = (seenTools.get(name) ?? 0) + 1;
        seenTools.set(name, seen);
        const laterExists = (toolCounts.get(name) ?? 0) > seen;
        if (!message.pinned && laterExists && message.bytes > options.maxResult * 4) {
            decisions.push({ index: message.index, kind: "drop", reason: "superseded_tool_result", toolName: name });
            continue;
        }

        if (message.bytes > options.maxResult) {
            kept.push(message);
            decisions.push({
                index: message.index,
                kind: "keep_call_truncate_result",
                reason: "truncate_tool_result",
                toolName: name,
            });
            continue;
        }

        kept.push(message);
        decisions.push({ index: message.index, kind: "keep_both", reason: "small_tool_result", toolName: name });
    }

    let lines = kept.map((message) => {
        const decision = decisions.find((item) => item.index === message.index);
        return serializeMessage(
            message,
            decision?.kind === "keep_call_truncate_result" ? options.maxResult : undefined
        );
    });
    let outBytes = measureBytes(lines);
    let reduction = inBytes === 0 ? 0 : 1 - outBytes / inBytes;

    if (reduction < 1 - options.keep) {
        const droppable = [...kept].filter(
            (message) =>
                !message.pinned &&
                isToolResult(message) &&
                decisions.find((item) => item.index === message.index)?.kind !== "drop"
        );
        while (droppable.length && 1 - measureBytes(lines) / inBytes < 1 - options.keep) {
            const next = droppable.shift();
            if (!next) {
                break;
            }

            const remain = kept.filter((message) => message !== next);
            kept.length = 0;
            kept.push(...remain);
            const existing = decisions.find((item) => item.index === next.index);
            if (existing) {
                existing.kind = "drop";
                existing.reason = "keep_ratio";
            }
            lines = kept.map((message) => {
                const decision = decisions.find((item) => item.index === message.index);
                return serializeMessage(
                    message,
                    decision?.kind === "keep_call_truncate_result" ? options.maxResult : undefined
                );
            });
        }
        outBytes = measureBytes(lines);
        reduction = inBytes === 0 ? 0 : 1 - outBytes / inBytes;
    }

    if (reduction < options.threshold) {
        return {
            unchanged: true,
            reason: "below_threshold",
            inBytes,
            outBytes: inBytes,
            reduction: 0,
            messages: pinned,
            lines: originalLines,
            decisions: pinned.map((message) => ({
                index: message.index,
                kind: "keep" as const,
                reason: "below_threshold",
                toolName: message.toolName,
            })),
        };
    }

    return {
        unchanged: false,
        inBytes,
        outBytes,
        reduction,
        messages: kept,
        lines,
        decisions,
    };
}
