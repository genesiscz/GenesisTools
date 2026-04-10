import type { SessionTimelineProps } from "../types";
import { MessageCard } from "./MessageCard";
import { SessionHeader } from "./SessionHeader";

export function SessionTimeline({ messages, sessionInfo, formatOptions }: SessionTimelineProps) {
    return (
        <div className="space-y-4">
            {sessionInfo && <SessionHeader sessionInfo={sessionInfo} />}
            {messages.map((msg, idx) => (
                <MessageCard key={idx} message={msg} formatOptions={formatOptions} />
            ))}
        </div>
    );
}
