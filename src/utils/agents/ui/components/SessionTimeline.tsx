import type { SessionTimelineProps } from "../types";
import { MessageCard } from "./MessageCard";
import { SessionHeader } from "./SessionHeader";

export function SessionTimeline({ messages, sessionInfo, formatOptions }: SessionTimelineProps) {
    return (
        <div className="space-y-3">
            {sessionInfo && <SessionHeader sessionInfo={sessionInfo} />}

            <div className="relative">
                {/* Subtle vertical connector line */}
                {messages.length > 1 && (
                    <div className="absolute left-[1.375rem] top-6 bottom-6 w-px bg-gradient-to-b from-secondary/15 via-primary/10 to-transparent pointer-events-none" />
                )}

                <div className="space-y-2">
                    {messages.map((msg, idx) => (
                        <MessageCard key={idx} message={msg} formatOptions={formatOptions} />
                    ))}
                </div>
            </div>
        </div>
    );
}
