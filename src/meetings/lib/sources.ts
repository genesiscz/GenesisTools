import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { MEETING_SOURCE_IDS, type MeetingSourceId, type TranscriptSource } from "@genesiscz/utils/meetings/sources";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";

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

/** Which source a record's transcript comes from: the first source block that names a meeting of its own. */
export interface SourceRef {
    sourceId: string;
    sourceMeetingId: string;
}

/** The record's linked source meeting, without loading the source; undefined when no source names one. */
export function sourceRefOf(record: MeetingRecord): SourceRef | undefined {
    for (const [sourceId, block] of Object.entries(record.sources)) {
        if (typeof block.meetingId === "string") {
            return { sourceId, sourceMeetingId: block.meetingId };
        }
    }

    return undefined;
}

export interface LinkedSource {
    source: TranscriptSource;
    sourceMeetingId: string;
}

/** The first linked source that names a meeting of its own, with that meeting's id. Throws a message ready to print. */
export async function linkedSource(record: MeetingRecord): Promise<LinkedSource> {
    const ref = sourceRefOf(record);

    if (!ref) {
        throw new Error(
            `${record.id} has no source with a transcript. Link one: ${toolCommand("meetings", "link", record.id, "wisprflow:<id>")}`
        );
    }

    return { source: await meetingSource(ref.sourceId), sourceMeetingId: ref.sourceMeetingId };
}

/** The linked source's transcript, on its own labels. */
export async function meetingTranscript(record: MeetingRecord): Promise<TranscriptEntry[]> {
    const { source, sourceMeetingId } = await linkedSource(record);
    return (await source.load(sourceMeetingId)).transcript;
}
