import { SafeJSON } from "@genesiscz/utils/json";
import type { Participant } from "./types";

interface SpeakerPerson {
    name?: string;
    origin?: string;
}

/** One diarized speaker. Each key names a person id; `user` is a manual pick in the app and wins. */
interface SpeakerAssignment {
    user?: string | null;
    consensus?: string | null;
    mic?: string | null;
    dom?: string | null;
    llm?: string | null;
}

interface SpeakerMap {
    people?: Record<string, SpeakerPerson>;
    assignments?: Record<string, SpeakerAssignment>;
}

const ASSIGNMENT_PRIORITY = ["user", "consensus", "mic", "dom", "llm"] as const;

/**
 * Reads the app's `Meetings.speakerMap` into one participant per diarized speaker.
 * A speaker nobody named stays out of the result, so callers fall back to "Speaker N".
 */
export function resolveSpeakers(raw: string | null | undefined): Participant[] {
    if (!raw) {
        return [];
    }

    const map = SafeJSON.parse(raw, { strict: true }) as SpeakerMap;
    const people = map.people ?? {};
    const participants: Participant[] = [];

    for (const [speakerKey, assignment] of Object.entries(map.assignments ?? {})) {
        const personId = ASSIGNMENT_PRIORITY.map((key) => assignment[key]).find((id) => id && people[id]);

        if (!personId) {
            continue;
        }

        const person = people[personId]!;
        participants.push({
            speakerId: Number(speakerKey),
            name: person.name ?? `Speaker ${speakerKey}`,
            origin: person.origin,
            isSelf: person.origin === "self",
        });
    }

    return participants.sort((a, b) => (a.speakerId ?? 0) - (b.speakerId ?? 0));
}

export function speakerLabel(participants: Participant[], speakerId: number | undefined): string {
    const named = participants.find((p) => p.speakerId === speakerId);

    if (named) {
        return named.name;
    }

    return speakerId === undefined ? "Unknown" : `Speaker ${speakerId}`;
}

/** The app writes speakers into its summary and notes as `<@speaker:N>`; the MCP resolves them server-side. */
export function fillSpeakerMentions(text: string, participants: Participant[]): string {
    return text.replace(/<@speaker:(\d+)>/g, (_, id: string) => speakerLabel(participants, Number(id)));
}

export function firstName(name: string): string {
    return name.split(/\s+/)[0] ?? name;
}
