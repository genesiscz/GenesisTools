import { ui } from "@genesiscz/utils/cli/ui";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import type { SourceMeeting } from "@genesiscz/utils/meetings/sources";
import type { Presence } from "@genesiscz/utils/transcribe/speakers";
import { loadPresence } from "./attendance";

/**
 * Who was in the call: `--attendance` when given, else the attendance stored in the meeting record. An infinite end
 * is stored as the meeting's last known time, so it reads back as a number.
 */
export async function presenceFor(
    record: MeetingRecord,
    meeting: SourceMeeting,
    spec?: string
): Promise<Presence[] | undefined> {
    if (spec) {
        const loaded = await loadPresence(
            { title: record.calendar?.title ?? meeting.title, start: meeting.start },
            spec
        );
        ui.dim(loaded.note);
        return loaded.presence;
    }

    if (record.attendance) {
        ui.dim(
            `attendance: ${record.attendance.people.length} stays stored in the meeting (${record.attendance.from})`
        );
        return record.attendance.people;
    }

    return undefined;
}
