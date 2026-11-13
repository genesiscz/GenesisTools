import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { sourceAudioSummary } from "./source-audio";

/** One meeting as `list --json` prints it: what a list needs. `show <meeting> --json` prints the whole record. */
export interface MeetingListRow {
    id: string;
    title: string;
    start: string;
    end?: string;
    project?: string;
    labels: string[];
    /** The linked sources' ids (`wisprflow`), not their blocks. */
    sources: string[];
    /** How many context entries the meeting has. */
    context: number;
    items: { suggested: number; confirmed: number; rejected: number };
    recording?: { status?: string; frames: number; bytes: number };
    sourceAudio?: { sources: string[]; bytes: number };
}

/**
 * A meeting's row for `list --json`. The whole records were 339 KB for 10 meetings, almost all of it items, history
 * and recording spans that a list does not show (R2-NR-X3); `list --json --full` still prints them.
 */
export function meetingListRow(record: MeetingRecord): MeetingListRow {
    const count = (status: "suggested" | "confirmed" | "rejected") =>
        record.items.filter((item) => item.status === status).length;

    const sourceAudio = sourceAudioSummary(record);
    return {
        ...(sourceAudio ? { sourceAudio } : {}),
        id: record.id,
        title: record.title,
        start: record.start,
        ...(record.end ? { end: record.end } : {}),
        ...(record.project ? { project: record.project } : {}),
        labels: record.labels,
        sources: Object.keys(record.sources),
        context: record.context.length,
        items: { suggested: count("suggested"), confirmed: count("confirmed"), rejected: count("rejected") },
        ...(record.recording
            ? {
                  recording: {
                      ...(record.recording.status ? { status: record.recording.status } : {}),
                      frames: record.recording.frames ?? 0,
                      bytes: record.recording.bytes ?? 0,
                  },
              }
            : {}),
    };
}

/**
 * The meetings `list` shows, newest first as the store lists them: one project's, then at most `limit`. The project
 * filter and the limit reach the store's read, so `list --limit 5` parses five matching records, not the whole store.
 */
export function selectMeetings(store: MeetingStore, options: { project?: string; limit?: number }): MeetingRecord[] {
    const { project, limit } = options;
    return store.listBounded({ limit, ...(project ? { where: (record) => record.project === project } : {}) }).records;
}
