import { DEFAULT_APPLY_ABOVE } from "@genesiscz/utils/meetings/config";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { sameName } from "@genesiscz/utils/transcribe/speakers";
import type { Seat } from "../sound";
import type { LineLabel, SpeakerLabeler } from "./types";

export const ATTENDANCE_CONFIDENCE = 0.95;
export const ENERGY_MIC_LEANS = 0.7;
export const ENERGY_CALL_LEANS = 0.5;

/** A sole occupant identifies the speaker only as far as the calibrated audio identifies their seat. */
export function seatConfidence({
    seat,
    energyMic,
    applyAbove = DEFAULT_APPLY_ABOVE,
}: {
    seat: Seat;
    energyMic?: number;
    applyAbove?: number;
}): number | undefined {
    if (energyMic === undefined) {
        return ATTENDANCE_CONFIDENCE;
    }

    if (energyMic === ENERGY_CALL_LEANS || (seat === "mic") !== energyMic > ENERGY_CALL_LEANS) {
        return undefined;
    }

    if (seat === "mic" && energyMic < ENERGY_MIC_LEANS) {
        // At a zero apply threshold every named answer applies, so leave this one unnamed.
        return applyAbove > 0 ? Math.min(energyMic, Math.max(0, Math.round(applyAbove * 100) - 1) / 100) : undefined;
    }

    return ATTENDANCE_CONFIDENCE;
}

export const seatLabeler: SpeakerLabeler = {
    id: "seat",
    rule: MeetingRule.Attendance,
    async propose(context) {
        return context.lines.map((line): LineLabel => {
            const stays = context.attended.filter(
                (stay) => stay.seat === line.seat && stay.fromSec < line.toSec && stay.toSec > line.fromSec
            );
            const people = stays
                .map((stay) => stay.person)
                .filter((person, index, names) => names.findIndex((other) => sameName(person, other)) === index);
            let through = line.fromSec;

            for (const stay of [...stays].sort((a, b) => a.fromSec - b.fromSec)) {
                if (stay.fromSec <= through) {
                    through = Math.max(through, stay.toSec);
                }
            }

            const confidence = seatConfidence({
                seat: line.seat,
                energyMic: line.energyMic,
                applyAbove: context.applyAbove,
            });
            const person =
                people.length === 1 &&
                through >= line.toSec &&
                confidence !== undefined &&
                (!line.eligible || (line.eligible.length === 1 && sameName(line.eligible[0]!, people[0]!)))
                    ? people[0]
                    : undefined;
            return {
                labeler: "seat",
                index: line.index,
                seat: line.seat,
                ...(person ? { person } : {}),
                ...(person && line.rosterOnly ? { reviewOnly: true } : {}),
                ...(person && confidence !== ATTENDANCE_CONFIDENCE ? { score: confidence } : {}),
                reason: person ? "seat-of-one" : people.length > 1 ? "seat-shared" : "seat-unknown",
            };
        });
    },
};
