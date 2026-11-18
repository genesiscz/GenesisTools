import { logger } from "@genesiscz/utils/logger";
import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { type LineEvidence, lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { OpenedMeeting } from "../opened-meeting";
import { decidedSeatRanges, suggestSeats } from "../seat-suggest";
import { type LinkedSource, sourceRefOf } from "../sources";

const { log } = logger.scoped("meetings-service");

export async function seatSuggestion({
    store,
    record,
    linked,
    params,
}: {
    store: MeetingStore;
    record: MeetingRecord;
    linked?: LinkedSource;
    params: Pick<Parameters<typeof suggestSeats>[0], "room" | "remote">;
}) {
    const ranges = decidedSeatRanges(record);
    let lines: LineEvidence[] = [];
    if (ranges.length && sourceRefOf(record)) {
        const opened = OpenedMeeting.of(store, record, linked);
        const [transcript, share] = await Promise.all([
            opened
                .meeting()
                .then((meeting) => meeting.transcript)
                .catch((error: unknown) => {
                    log.warn({ error, meeting: record.id }, "seat suggestions without transcript lines");
                    return [];
                }),
            opened
                .energy()
                .then((energy) => energy.share)
                .catch((error: unknown) => {
                    log.warn({ error, meeting: record.id }, "seat suggestions without channel energy");
                    return undefined;
                }),
        ]);
        lines = lineEvidence(transcript, { segments: [], speaking: [] }, undefined, share);
    }
    return {
        meeting: record.id,
        current: record.seats ?? null,
        suggestion: suggestSeats({ record, ranges, lines, room: params.room, remote: params.remote }),
    };
}
