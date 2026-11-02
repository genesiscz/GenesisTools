import { similarityScore } from "@genesiscz/utils/fuzzy-match";
import type { Presence } from "./speakers";
import type { TranscriptEntry } from "./types";

/** A stretch of the recording and the audio channel it came from: the user's microphone, or the call's sound. */
export interface EvidenceSegment {
    startSec: number;
    endSec: number;
    channel: "mic" | "system";
    /** The name the meeting platform showed while it was said (weak: it lags a few seconds behind the voice). */
    liveName?: string;
    /** What the live recognizer heard, for the echo check. */
    text?: string;
    /** The live recognizer's voice id: its own clustering, separate from the refined transcript's speaker ids. */
    voiceId?: number;
}

/** Who the meeting platform showed as speaking (and muted) at one moment. */
export interface SpeakingObservation {
    tSec: number;
    speaking: string[];
    /** Who was muted; absent when the reading did not read the mute state (Teams leaves it out of most readings). */
    muted?: string[];
}

/** A mute state read this long before a line still holds at its start: mute is a state, not an event. */
const MUTED_CARRY_SEC = 10;

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
    /** The line's own text: taken from its entry, never looked up by time (two lines can start in one second). */
    text: string;
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
    /** The refined transcript's speaker id of the line. */
    refinedSpeakerId?: number;
    /** The live recognizer's voice id of the winning segment (its own clustering). */
    liveVoiceId?: number;
    /**
     * The highest text similarity between a microphone segment and a call-sound segment in the line: near 1 means the
     * microphone picked up the speakers (echo), so the microphone does not prove the user spoke.
     */
    echo?: number;
    /** The people the platform showed muted in every reading over the line (rule RM: they did not speak it). */
    muted?: string[];
    /**
     * The microphone channel's share of the audio energy in the line; undefined without audio, when quiet, or when the
     * recording's channel layout is unknown (calibrated per recording).
     */
    energyMic?: number;
}

function plainText(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, "")
        .replace(/\s+/g, " ")
        .trim();
}

/** The highest similarity between any microphone and any call-sound segment text overlapping the line. */
function echoScore(segments: EvidenceSegment[]): number | undefined {
    const mic = segments
        .filter((segment) => segment.channel === "mic" && segment.text)
        .map((segment) => plainText(segment.text!));
    const call = segments
        .filter((segment) => segment.channel === "system" && segment.text)
        .map((segment) => plainText(segment.text!));
    let best: number | undefined;

    for (const a of mic) {
        for (const b of call) {
            const score = similarityScore(a, b);
            best = best === undefined ? score : Math.max(best, score);
        }
    }

    return best;
}

/** E1 channel, E3 speaking indicator and E4 live name for every timed line, plus E2 attendance when given. */
export function lineEvidence(
    entries: TranscriptEntry[],
    evidence: { segments: EvidenceSegment[]; speaking: SpeakingObservation[] },
    presence?: Presence[],
    /** The microphone channel's share of the audio energy over a time range, when the audio is at hand. */
    energyMicShare?: (fromSec: number, toSec: number) => number | undefined
): LineEvidence[] {
    const timed = entries.filter((entry) => entry.startSec !== undefined && entry.text.trim());

    return timed.map((entry, index) => {
        const startSec = entry.startSec!;
        const endSec = Math.max(timed[index + 1]?.startSec ?? startSec + LAST_LINE_SEC, startSec + 1);
        const overlap = new Map<string, { sec: number; liveName?: string; voiceId?: number; longest: number }>();
        const touching: EvidenceSegment[] = [];

        for (const segment of evidence.segments) {
            const sec = Math.min(endSec, segment.endSec) - Math.max(startSec, segment.startSec);

            if (sec <= 0) {
                continue;
            }

            touching.push(segment);
            const identity = segment.channel === "mic" ? SELF : (segment.liveName ?? "?");
            const seen = overlap.get(identity);
            const longer = sec > (seen?.longest ?? 0);
            overlap.set(identity, {
                sec: (seen?.sec ?? 0) + sec,
                liveName: segment.liveName ?? seen?.liveName,
                voiceId: longer ? segment.voiceId : seen?.voiceId,
                longest: longer ? sec : (seen?.longest ?? 0),
            });
        }

        const echo = echoScore(touching);
        const energyMic = energyMicShare?.(startSec, endSec);

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

        const readings: SpeakingObservation[] = [];

        for (const observation of evidence.speaking) {
            if (observation.tSec >= startSec - SPEAKING_LEAD_SEC && observation.tSec < endSec) {
                count(observation.speaking);
                readings.push(observation);
            }
        }

        const atStart = evidence.speaking.findLast((observation) => observation.tSec <= startSec);

        if (atStart) {
            count(atStart.speaking);

            if (!readings.includes(atStart)) {
                readings.push(atStart);
            }
        }

        // Only readings that read the mute state count, and the last one before the line still holds in it.
        const muteReads = evidence.speaking.filter(
            (observation) =>
                observation.muted !== undefined &&
                observation.tSec >= startSec - MUTED_CARRY_SEC &&
                observation.tSec < endSec
        );
        const lastBefore = muteReads.findLast((observation) => observation.tSec <= startSec);
        const counted = [
            ...(lastBefore ? [lastBefore] : []),
            ...muteReads.filter((observation) => observation.tSec > startSec),
        ];
        const muted = counted[0]?.muted?.filter((name) => counted.every((reading) => reading.muted?.includes(name)));

        const present = presence
            ?.filter((stay) => startSec >= stay.fromSec - 5 && startSec <= stay.toSec + 5)
            .map((stay) => stay.name);

        return {
            index,
            startSec,
            endSec,
            label: entry.speaker,
            text: entry.text,
            ...(total > 0 ? { micShare: (overlap.get(SELF)?.sec ?? 0) / total } : {}),
            ...(winner && best ? { winner, winnerShare: best.sec / total } : {}),
            ...(tie ? { tie: true } : {}),
            ...(winner && winner !== SELF && best?.liveName ? { liveName: best.liveName } : {}),
            speaking,
            ...(present ? { present: [...new Set(present)] } : {}),
            ...(entry.speakerId !== undefined ? { refinedSpeakerId: entry.speakerId } : {}),
            ...(best?.voiceId !== undefined ? { liveVoiceId: best.voiceId } : {}),
            ...(echo !== undefined ? { echo } : {}),
            ...(energyMic !== undefined ? { energyMic } : {}),
            ...(muted && muted.length > 0 ? { muted } : {}),
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
