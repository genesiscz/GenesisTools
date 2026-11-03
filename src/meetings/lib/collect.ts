import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { type CollectOutcome, OpenedMeeting } from "./opened-meeting";

export type { CollectOutcome };

/** `OpenedMeeting.collect` for a record: the platform, the attendance and the channel layout, as notes. */
export async function collectRecord(store: MeetingStore, record: MeetingRecord): Promise<CollectOutcome> {
    return OpenedMeeting.of(store, record).collect();
}

/** Collects and prints one line per note; a failure here never fails the command that linked the recording. */
export async function collectAndReport(store: MeetingStore, record: MeetingRecord): Promise<MeetingRecord> {
    return OpenedMeeting.of(store, record).collectAndReport();
}
