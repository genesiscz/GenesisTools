import { MEETING_SOURCE_IDS, type MeetingSourceId, type TranscriptSource } from "@genesiscz/utils/meetings/sources";

/** One loader per source. The table lives in the tool, because a source is implemented in its own tool. */
const MEETING_SOURCES: Record<MeetingSourceId, () => Promise<TranscriptSource>> = {
    wisprflow: () => import("@app/wisprflow/lib/meeting-source").then((module) => module.wisprflowSource),
};

export function isMeetingSourceId(value: string): value is MeetingSourceId {
    return (MEETING_SOURCE_IDS as readonly string[]).includes(value);
}

export async function meetingSource(id: string): Promise<TranscriptSource> {
    if (!isMeetingSourceId(id)) {
        throw new Error(`Unknown source "${id}". Known: ${MEETING_SOURCE_IDS.join(", ")}`);
    }

    return MEETING_SOURCES[id]();
}
