import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { sameName } from "@genesiscz/utils/transcribe/speakers";
import type { LineLabel, SpeakerLabeler } from "./types";

export const ATTENDANCE_CONFIDENCE = 0.95;

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

            const person = people.length === 1 && through >= line.toSec ? people[0] : undefined;
            return {
                labeler: "seat",
                index: line.index,
                seat: line.seat,
                ...(person ? { person } : {}),
                reason: person ? "seat-of-one" : people.length > 1 ? "seat-shared" : "seat-unknown",
            };
        });
    },
};
