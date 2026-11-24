import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { speakerLabel } from "@genesiscz/utils/transcribe/speakers";
import type { Participant } from "@genesiscz/utils/transcribe/types";

const { log } = logger.scoped("wisprflow-mentions");

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

/** The recording user's name: the person the app marks `origin: "self"`, whether or not a speaker is assigned to them. */
export function selfName(raw: string | null | undefined): string | undefined {
    if (!raw) {
        return undefined;
    }

    const map = SafeJSON.parse(raw, { strict: true }) as SpeakerMap;
    return Object.values(map.people ?? {}).find((person) => person.origin === "self")?.name;
}

/** What a person mention reads as when the app gave it no usable name. It marks the gap; it never invents a person. */
export const UNNAMED_PERSON = "(unnamed person)";

/**
 * The app's summary and notes carry two kinds of mention:
 * - `<@speaker:N>`: a diarized speaker of this meeting, `N` is the number in the speaker map.
 * - `<@personN:n=Ale%C5%A1%20Example>`: a person the summary names, with the name URL-encoded after `n=`. Fields are joined
 *   by `;` (`<@person2:c=<contact id>;n=Alice%20Example>`) and `c=` can come without `n=`. `N` is the app's own
 *   index of that person inside the summary text. It is NOT a speaker of this meeting, and one summary can give the
 *   same index to different people.
 */
const MENTION = /<@(?:speaker:(\d+)|person(\d+)(?::([^>]*))?)>/g;

/** A percent-encoded name as plain text. A bad escape keeps its raw bytes and decodes the valid ones around it. */
function decodeMentionName(encoded: string): string {
    try {
        return decodeURIComponent(encoded);
    } catch {
        log.debug({ length: encoded.length }, "wispr mention name has a bad percent escape; decoded what is valid");
        return encoded.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
            try {
                return decodeURIComponent(run);
            } catch {
                return run;
            }
        });
    }
}

function personMentionName(person: number, fields: string | undefined): string {
    const encoded = fields
        ?.split(";")
        .map((field) => field.split(/=(.*)/s))
        .find(([key]) => key === "n")?.[1];
    const name = encoded === undefined ? "" : decodeMentionName(encoded).replace(/\s+/g, " ").trim();

    if (!name) {
        // The log carries the app's person index and the reason, never the name or the contact id.
        log.debug({ person, hasFields: fields !== undefined }, "wispr person mention has no name");
        return UNNAMED_PERSON;
    }

    return name;
}

/**
 * Turns the app's mentions in a summary or notes into plain text, in one pass. A speaker mention becomes that
 * speaker's name ("Speaker N" when nobody named them). A person mention becomes its decoded `n=` name, never a
 * speaker, whatever its index says.
 */
export function fillMentions(text: string, participants: Participant[]): string {
    return text.replace(MENTION, (_, speaker?: string, person?: string, fields?: string) =>
        speaker === undefined ? personMentionName(Number(person), fields) : speakerLabel(participants, Number(speaker))
    );
}
