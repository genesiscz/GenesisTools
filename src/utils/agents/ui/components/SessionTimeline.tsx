import { useMemo } from "react";

import type { AgentMessage } from "../../types";
import type { SessionTimelineProps } from "../types";
import { MessageCard } from "./MessageCard";
import { SessionHeader } from "./SessionHeader";

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

    return (
        <div className="space-y-3">
            {sessionInfo && <SessionHeader sessionInfo={sessionInfo} />}

            <div className="relative">
                {mergedMessages.length > 1 && (
                    <div className="absolute left-[1.375rem] top-6 bottom-6 w-px bg-gradient-to-b from-secondary/15 via-primary/10 to-transparent pointer-events-none" />
                )}

                <div className="space-y-2">
                    {mergedMessages.map((msg, idx) => (
                        <MessageCard key={idx} message={msg} formatOptions={formatOptions} />
                    ))}
                </div>
            </div>
        </div>
    );
}
