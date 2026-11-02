import type { Presence } from "./speakers";
import type { TranscriptEntry } from "./types";

/** A stretch of the recording and the audio channel it came from: the user's microphone, or the call's sound. */
export interface EvidenceSegment {
    startSec: number;
    endSec: number;
    channel: "mic" | "system";
    /** The name the meeting platform showed while it was said (weak: it lags a few seconds behind the voice). */
    liveName?: string;
}

/** Who the meeting platform showed as speaking (and muted) at one moment. */
export interface SpeakingObservation {
    tSec: number;
    speaking: string[];
    muted: string[];
}

/** The identity of the recording user in evidence: the microphone channel is always them. */
export const SELF = "self";

/** Two identities whose overlap differs by less than this share are a tie: the line has no winner. */
const TIE_SHARE = 0.001;
/** A line with no next line counts this long. */
const LAST_LINE_SEC = 5;
/** Teams' indicator is read about every 5 s, so a line also counts what it showed this long before it. */
const SPEAKING_LEAD_SEC = 1;

export interface LineEvidence {
    index: number;
    startSec: number;
    endSec: number;
    label: string;
    /** The share of the line's overlap with microphone segments; undefined when no segment overlaps. */
    micShare?: number;
    /** The identity with the most overlap: `self` (microphone) or the platform's name for the call sound. */
    winner?: string;
    /** The two biggest identities overlap the line equally, so it has no winner. */
    tie?: boolean;
    winnerShare?: number;
    /** The platform's name of the winning call-sound segment. */
    liveName?: string;
    /** How often each name was shown speaking during the line. */
    speaking: Record<string, number>;
    /** Who was in the call at the line's start (with attendance). */
    present?: string[];
}

/** E1 channel, E3 speaking indicator and E4 live name for every timed line, plus E2 attendance when given. */
export function lineEvidence(
    entries: TranscriptEntry[],
    evidence: { segments: EvidenceSegment[]; speaking: SpeakingObservation[] },
    presence?: Presence[]
): LineEvidence[] {
    const timed = entries.filter((entry) => entry.startSec !== undefined && entry.text.trim());

    return timed.map((entry, index) => {
        const startSec = entry.startSec!;
        const endSec = Math.max(timed[index + 1]?.startSec ?? startSec + LAST_LINE_SEC, startSec + 1);
        const overlap = new Map<string, { sec: number; liveName?: string }>();

        for (const segment of evidence.segments) {
            const sec = Math.min(endSec, segment.endSec) - Math.max(startSec, segment.startSec);

            if (sec <= 0) {
                continue;
            }

            const identity = segment.channel === "mic" ? SELF : (segment.liveName ?? "?");
            const seen = overlap.get(identity);
            overlap.set(identity, { sec: (seen?.sec ?? 0) + sec, liveName: segment.liveName ?? seen?.liveName });
        }

        const total = [...overlap.values()].reduce((sum, value) => sum + value.sec, 0);
        const ranked = [...overlap.entries()].sort((a, b) => b[1].sec - a[1].sec);
        const tie = ranked.length > 1 && total > 0 && (ranked[0]![1].sec - ranked[1]![1].sec) / total < TIE_SHARE;
        const [winner, best] = tie ? [] : (ranked[0] ?? []);
        const speaking: Record<string, number> = {};
        const count = (names: string[]) => {
            for (const name of names) {
                speaking[name] = (speaking[name] ?? 0) + 1;
            }
        };

        for (const observation of evidence.speaking) {
            if (observation.tSec >= startSec - SPEAKING_LEAD_SEC && observation.tSec < endSec) {
                count(observation.speaking);
            }
        }

        const atStart = evidence.speaking.findLast((observation) => observation.tSec <= startSec);

        if (atStart) {
            count(atStart.speaking);
        }

        const present = presence
            ?.filter((stay) => startSec >= stay.fromSec - 5 && startSec <= stay.toSec + 5)
            .map((stay) => stay.name);

        return {
            index,
            startSec,
            endSec,
            label: entry.speaker,
            ...(total > 0 ? { micShare: (overlap.get(SELF)?.sec ?? 0) / total } : {}),
            ...(winner && best ? { winner, winnerShare: best.sec / total } : {}),
            ...(tie ? { tie: true } : {}),
            ...(winner && winner !== SELF && best?.liveName ? { liveName: best.liveName } : {}),
            speaking,
            ...(present ? { present: [...new Set(present)] } : {}),
        };
    });
}

/** How many lines of each label each identity won: the label-by-identity table. */
export function labelIdentityTable(lines: LineEvidence[]): Map<string, Map<string, number>> {
    const table = new Map<string, Map<string, number>>();

    for (const line of lines) {
        const row = table.get(line.label) ?? new Map<string, number>();
        const identity = line.winner ?? (line.tie ? "tie" : "?");
        row.set(identity, (row.get(identity) ?? 0) + 1);
        table.set(line.label, row);
    }

    return table;
}
