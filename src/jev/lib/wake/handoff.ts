import type { LiveTranscriptEvent } from "@genesiscz/utils/ai/stt";

export function eventsAfterWake(events: LiveTranscriptEvent[], wakeAtMs: number): LiveTranscriptEvent[] {
    return events.filter((event) => event.startedAtMs >= wakeAtMs);
}
