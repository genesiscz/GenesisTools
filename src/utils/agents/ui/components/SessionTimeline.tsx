import type { AgentMessage } from "@genesiscz/utils/agents/types";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SessionTimelineProps } from "../types";
import { MessageCard } from "./MessageCard";
import { SessionHeader } from "./SessionHeader";

export const INITIAL_TIMELINE_MESSAGES = 100;
const TIMELINE_WINDOW_STEP = 100;

export function timelineWindow<T>(items: T[], visibleCount: number): { start: number; items: T[] } {
    const count = Math.max(1, visibleCount);
    const start = Math.max(0, items.length - count);
    return { start, items: items.slice(start) };
}

interface TimelineRange {
    start: number;
    end: number;
    followTail: boolean;
}

function initialTimelineRange(length: number): TimelineRange {
    return { start: Math.max(0, length - INITIAL_TIMELINE_MESSAGES), end: length, followTail: true };
}

/**
 * Merge consecutive assistant messages that contain only tool calls/results.
 *
 * The server serializes each Claude turn separately, so 5 tool calls in a row
 * produce 5 identical "ASSISTANT" cards. This merges them into one card with
 * all tool calls listed together.
 */
function mergeConsecutiveToolMessages(messages: AgentMessage[]): AgentMessage[] {
    const merged: AgentMessage[] = [];

    for (const msg of messages) {
        const prev = merged[merged.length - 1];
        const isToolOnly =
            msg.blocks.length > 0 && msg.blocks.every((b) => b.type === "tool_call" || b.type === "tool_result");
        const prevIsToolOnly =
            prev &&
            prev.blocks.length > 0 &&
            prev.blocks.every((b) => b.type === "tool_call" || b.type === "tool_result");

        if (prev && prev.role === "assistant" && msg.role === "assistant" && isToolOnly && prevIsToolOnly) {
            prev.blocks.push(...msg.blocks);
        } else {
            merged.push({ ...msg, blocks: [...msg.blocks] });
        }
    }

    return merged;
}

export function SessionTimeline({ messages, sessionInfo, formatOptions }: SessionTimelineProps) {
    const mergedMessages = useMemo(() => mergeConsecutiveToolMessages(messages), [messages]);
    const [range, setRange] = useState<TimelineRange>(() => initialTimelineRange(mergedMessages.length));
    const visibleStart = Math.min(range.start, mergedMessages.length);
    const visibleEnd = Math.min(Math.max(range.end, visibleStart), mergedMessages.length);
    const visibleMessages = mergedMessages.slice(visibleStart, visibleEnd);
    const newerCount = mergedMessages.length - visibleEnd;
    const listRef = useRef<HTMLDivElement>(null);
    const priorScrollHeight = useRef<number | null>(null);
    const priorLength = useRef(mergedMessages.length);
    const priorSessionId = useRef(sessionInfo?.id);

    useEffect(() => {
        const sessionChanged = priorSessionId.current !== sessionInfo?.id;
        const delta = mergedMessages.length - priorLength.current;
        priorLength.current = mergedMessages.length;
        priorSessionId.current = sessionInfo?.id;

        if (sessionChanged || delta < 0) {
            setRange(initialTimelineRange(mergedMessages.length));
            return;
        }

        if (delta > 0) {
            setRange((current) => (current.followTail ? initialTimelineRange(mergedMessages.length) : current));
        }
    }, [mergedMessages.length, sessionInfo?.id]);

    useLayoutEffect(() => {
        if (priorScrollHeight.current === null || !listRef.current) {
            return;
        }

        const addedHeight = listRef.current.scrollHeight - priorScrollHeight.current;
        priorScrollHeight.current = null;
        if (addedHeight !== 0) {
            window.scrollBy({ top: addedHeight });
        }
    }, [range.start]);

    const showEarlier = () => {
        priorScrollHeight.current = listRef.current?.scrollHeight ?? null;
        setRange((current) => ({
            ...current,
            start: Math.max(0, current.start - TIMELINE_WINDOW_STEP),
            followTail: false,
        }));
    };

    const jumpToNewer = () => setRange(initialTimelineRange(mergedMessages.length));

    return (
        <div className="space-y-3">
            {sessionInfo && <SessionHeader sessionInfo={sessionInfo} />}

            <div className="relative">
                {mergedMessages.length > 1 && (
                    <div className="absolute left-[1.375rem] top-6 bottom-6 w-px bg-gradient-to-b from-secondary/15 via-primary/10 to-transparent pointer-events-none" />
                )}

                <div ref={listRef} className="space-y-2">
                    {visibleStart > 0 && (
                        <button
                            type="button"
                            onClick={showEarlier}
                            className="w-full rounded-md border border-primary/15 px-3 py-2 text-xs font-mono text-muted-foreground hover:border-primary/30 hover:text-foreground"
                        >
                            Show {Math.min(TIMELINE_WINDOW_STEP, visibleStart)} earlier messages
                        </button>
                    )}
                    {visibleMessages.map((msg, idx) => (
                        <MessageCard key={visibleStart + idx} message={msg} formatOptions={formatOptions} />
                    ))}
                    {newerCount > 0 && (
                        <button
                            type="button"
                            onClick={jumpToNewer}
                            className="w-full rounded-md border border-secondary/15 px-3 py-2 text-xs font-mono text-muted-foreground hover:border-secondary/30 hover:text-foreground"
                        >
                            Jump to {newerCount} newer {newerCount === 1 ? "message" : "messages"}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
