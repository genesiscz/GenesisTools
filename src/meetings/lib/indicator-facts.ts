import type { MeetingEvidence, SourceMeeting } from "@genesiscz/utils/meetings/sources";
import { TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import { type Presence, sameName } from "@genesiscz/utils/transcribe/speakers";

export interface IndicatorGap {
    fromSec: number;
    toSec: number;
    reason: string;
}
export interface LabelPrehistory {
    label: string;
    firstOwnIndicatorSec?: number;
    firstJoinSec?: number;
    fromSec?: number;
    toSec?: number;
    lines: number;
}

/** Empty readings give no indicator evidence, including when the people panel is hidden. */
export function indicatorFacts(options: {
    meeting: SourceMeeting;
    evidence: MeetingEvidence | null;
    presence?: Presence[];
}): { gaps: IndicatorGap[]; labels: LabelPrehistory[]; people: string[] } {
    const readings = options.evidence?.speaking ?? [];
    const addressed = new TranscriptLines(options.meeting.transcript);
    const timed = options.meeting.transcript.flatMap((entry, index) =>
        entry.startSec === undefined
            ? []
            : [{ entry, startSec: entry.startSec, endSec: addressed.end(index) ?? entry.startSec }]
    );
    const end = Math.max(0, ...timed.map((line) => line.endSec));
    const observations = readings
        .filter((reading) => reading.speaking.length || reading.muted?.length)
        .map((reading) => reading.tSec)
        .sort((a, b) => a - b);
    const boundaries = [...new Set([0, ...observations, end])];
    const gaps: IndicatorGap[] = [];
    for (let index = 1; index < boundaries.length; index++) {
        const fromSec = boundaries[index - 1]!;
        const toSec = boundaries[index]!;
        if (
            toSec - fromSec >= 60 &&
            timed.some((line) => line.startSec >= fromSec && line.startSec < toSec && line.entry.text.trim())
        ) {
            gaps.push({ fromSec, toSec, reason: "no speaking or muted indicator observation" });
        }
    }
    const labels = options.meeting.speakers
        .filter((speaker) => speaker.origin === "platform")
        .map((speaker): LabelPrehistory => {
            const firstOwnIndicatorSec = readings
                .filter((reading) => reading.speaking.some((name) => sameName(name, speaker.name)))
                .map((reading) => reading.tSec)
                .sort((a, b) => a - b)[0];
            const firstJoinSec = options.presence
                ?.filter((stay) => sameName(stay.name, speaker.name))
                .map((stay) => stay.fromSec)
                .sort((a, b) => a - b)[0];
            const boundary = Math.min(firstOwnIndicatorSec ?? Infinity, firstJoinSec ?? Infinity);
            const early = Number.isFinite(boundary)
                ? timed.filter((line) => sameName(line.entry.speaker, speaker.name) && line.startSec < boundary)
                : [];
            return {
                label: speaker.name,
                firstOwnIndicatorSec,
                firstJoinSec,
                lines: early.length,
                ...(early.length >= 10 ? { fromSec: early[0]!.startSec, toSec: early.at(-1)!.startSec } : {}),
            };
        });
    return {
        gaps,
        labels,
        people: [...new Set(readings.flatMap((reading) => [...reading.speaking, ...(reading.muted ?? [])]))],
    };
}
