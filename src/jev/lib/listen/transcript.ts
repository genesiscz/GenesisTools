import type { LiveTranscriptEvent } from "@genesiscz/utils/ai/stt";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";
import { eventsAfterWake } from "../wake/handoff";

const { log } = logger.scoped("jev-listen");

const transcriptEventSchema = z.object({
    kind: z.enum(["partial", "final", "speech_start", "speech_end", "error"]),
    text: z.string(),
    isFinal: z.boolean().optional(),
    startedAtMs: z.number().optional(),
});

export async function loadTranscript(
    path: string,
    fromWake: boolean,
    phrases: string[]
): Promise<LiveTranscriptEvent[]> {
    const text = await Bun.file(path).text();
    let events = parseTranscript(text);
    log.info({ path, events: events.length, fromWake }, "transcript loaded");
    if (fromWake) {
        const trigger = [...events]
            .reverse()
            .find((event) => phrases.some((phrase) => event.text.toLowerCase().includes(phrase.toLowerCase())));
        events = eventsAfterWake(events, trigger?.startedAtMs ?? 0);
    }

    return events;
}

export function parseTranscript(text: string): LiveTranscriptEvent[] {
    return text
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => transcriptEventSchema.parse(SafeJSON.parse(line, { jsonl: true })))
        .map((event) => ({
            kind: event.kind,
            text: event.text,
            isFinal: event.isFinal ?? event.kind === "final",
            startedAtMs: event.startedAtMs ?? 0,
        }));
}
