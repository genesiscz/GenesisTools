import type { MeetingItem } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { type LineEvidence, SELF } from "@genesiscz/utils/transcribe/evidence";
import { ARRIVAL_PHRASES, type Presence, sameName } from "@genesiscz/utils/transcribe/speakers";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";

type RangeItem = Omit<Extract<MeetingItem, { kind: "speaker-range" }>, "id" | "suggestedAt">;

/** A person who joins speaks first within this many seconds (rule R16). */
const ARRIVAL_WINDOW_SEC = 60;
/** A stay that starts this close to second 0 was there from the start, not an arrival. */
const FROM_START_SEC = 5;
const CONFIDENCE = { phrase: 0.65, firstReading: 0.55, overruled: 0.35 } as const;

/**
 * Rule R16: within 60 s after a person joins, a greeting or a newcomer's question ("o co jsem přišel") under another
 * label is theirs. So is the line where the platform first shows them speaking, which catches a greeting the
 * recognizer misheard ("Plus." for "čus"). The microphone (E1) or someone else on the speaking indicator (E3) at that
 * line lowers the item under the listen threshold instead of dropping it.
 */
export function arrivalItems(options: {
    entries: TranscriptEntry[];
    lines: LineEvidence[];
    presence: Presence[] | undefined;
    speakingReadings: Array<{ tSec: number; speaking: string[] }>;
}): RangeItem[] {
    const items: RangeItem[] = [];
    const textAt = new Map(
        options.entries.filter((entry) => entry.startSec !== undefined).map((entry) => [entry.startSec!, entry.text])
    );

    for (const stay of options.presence ?? []) {
        if (stay.self || stay.joinedAtExact === false || stay.fromSec < FROM_START_SEC) {
            continue;
        }

        const windowEnd = stay.fromSec + ARRIVAL_WINDOW_SEC;
        const inWindow = options.lines.filter(
            (line) => line.startSec >= stay.fromSec && line.startSec <= windowEnd && !sameName(line.label, stay.name)
        );
        const firstReading = options.speakingReadings.find(
            (reading) =>
                reading.tSec >= stay.fromSec &&
                reading.tSec <= windowEnd &&
                reading.speaking.some((name) => sameName(name, stay.name))
        );

        for (const line of inWindow) {
            const text = textAt.get(line.startSec) ?? "";
            const greets = ARRIVAL_PHRASES.some((phrase) => phrase.test(text));
            const firstSpoke =
                firstReading !== undefined && firstReading.tSec >= line.startSec && firstReading.tSec < line.endSec;

            if (!greets && !firstSpoke) {
                continue;
            }

            const micSaysUser =
                line.energyMic !== undefined
                    ? line.energyMic >= 0.9
                    : line.winner === SELF && (line.micShare ?? 0) >= 0.9;
            const shownOthers = Object.keys(line.speaking).filter((name) => !sameName(name, stay.name));
            const joinerShown = Object.keys(line.speaking).some((name) => sameName(name, stay.name));
            const overruled = micSaysUser || (shownOthers.length > 0 && !joinerShown);
            const confidence = overruled ? CONFIDENCE.overruled : greets ? CONFIDENCE.phrase : CONFIDENCE.firstReading;
            items.push({
                kind: "speaker-range",
                status: "suggested",
                label: line.label,
                fromSec: line.startSec,
                toSec: line.startSec,
                speaker: stay.name,
                confidence,
                rules: greets ? [MeetingRule.Arrival] : [MeetingRule.Arrival, MeetingRule.SpeakingIndicator],
                evidence: {
                    endSec: line.endSec,
                    joinedSec: stay.fromSec,
                    note: greets
                        ? `greets within ${Math.round(line.startSec - stay.fromSec)} s of ${stay.name} joining`
                        : `${stay.name} first shown speaking here, ${Math.round(line.startSec - stay.fromSec)} s after joining`,
                    ...(overruled
                        ? {
                              listen: true,
                              overruledBy: micSaysUser ? MeetingRule.Channel : MeetingRule.SpeakingIndicator,
                          }
                        : {}),
                },
            });
        }
    }

    return items;
}
