import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { MeetingsStateError } from "@genesiscz/utils/meetings/conflict";
import type { JoinPart, MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import {
    MEETING_SOURCE_IDS,
    type MeetingSourceId,
    type SourceMeeting,
    type TranscriptSource,
} from "@genesiscz/utils/meetings/sources";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { joinedCopyRef, type RecordingRef } from "./joined-source";
import type { LocalSourceAudio } from "./source-audio-discovery";
import {
    copyBackedSource,
    copyOnlySource,
    hasSourceCopy,
    ownedCopySource,
    readSourceCopy,
    type SourceCopyRef,
} from "./source-copy";

const { log } = logger.scoped("meetings-sources");

/** Source capabilities live together; a local preview must never use an automatic remote fallback. */
const MEETING_SOURCES: Record<
    MeetingSourceId,
    {
        open: () => Promise<TranscriptSource>;
        localTranscript: (sourceMeetingId: string) => Promise<TranscriptEntry[]>;
    }
> = {
    wisprflow: {
        // lint-rules-ignore: each meeting source brings its own reader, loaded on demand
        open: () => import("@app/wisprflow/lib/meeting-source").then((module) => module.wisprflowSource),
        localTranscript: async (sourceMeetingId) => {
            // lint-rules-ignore: each meeting source brings its own reader, loaded on demand
            const { loadMeeting } = await import("@app/wisprflow/lib/source");
            return (await loadMeeting(sourceMeetingId, { source: "local", transcript: true })).data.transcript;
        },
    },
};

const LOCAL_SOURCE_AUDIO: Record<MeetingSourceId, () => Promise<LocalSourceAudio>> = {
    // lint-rules-ignore: each meeting source brings its own reader, loaded on demand
    wisprflow: () => import("@app/wisprflow/lib/source-audio").then((module) => module.wisprLocalAudio),
};

/** Local media only: never loads provider evidence or falls back to a remote service. */
export async function localSourceAudio(id: string): Promise<LocalSourceAudio> {
    if (!isMeetingSourceId(id)) {
        throw new Error(`Unknown local audio source: ${id}`);
    }
    return LOCAL_SOURCE_AUDIO[id]();
}

export function isMeetingSourceId(value: string): value is MeetingSourceId {
    return (MEETING_SOURCE_IDS as readonly string[]).includes(value);
}

export async function meetingSource(id: string): Promise<TranscriptSource> {
    if (!isMeetingSourceId(id)) {
        throw new Error(`Unknown source "${id}". Known: ${MEETING_SOURCE_IDS.join(", ")}`);
    }

    const source = await MEETING_SOURCES[id].open();
    return {
        ...source,
        load: async (sourceMeetingId, options) => composedMeeting(await source.load(sourceMeetingId, options)),
    };
}

/** The meeting this Mac's provider records right now (the source-audio passes' live lookup in production). */
export async function liveSourceMeetingId(id: MeetingSourceId): Promise<string | undefined> {
    return (await (await meetingSource(id)).liveRecording())?.sourceMeetingId;
}

/**
 * The meeting with its speaker labels and names composed (NFC). The CLI composes its arguments (`src/meetings/index.ts`),
 * so a label typed or answered in the window matches a source label only when the source's is composed too.
 */
export function composedMeeting(meeting: SourceMeeting): SourceMeeting {
    return {
        ...meeting,
        participants: meeting.participants.map((person) => ({ ...person, name: person.name.normalize("NFC") })),
        speakers: meeting.speakers.map((speaker) => ({ ...speaker, name: speaker.name.normalize("NFC") })),
        transcript: composedTranscript(meeting.transcript),
    };
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

/**
 * The first linked source that names a meeting of its own, with that meeting's id. Throws a message ready to print.
 * With the record's `store`, the source keeps the record's own copy of its answers (source-copy.ts) and answers from
 * that copy when it cannot read: its source code cannot be opened, or a read fails. `saveCopy: false` still answers from
 * the copy but never writes it (a probe).
 * A joined record answers from its own copy of the joined meeting (`joinedRecordSource`), with the first recording's
 * meeting id, which that source does not read.
 */
export async function linkedSource(
    record: MeetingRecord,
    store?: MeetingStore,
    options: { saveCopy?: boolean } = {}
): Promise<LinkedSource> {
    if (record.join) {
        return {
            source: await joinedRecordSource(record, store),
            sourceMeetingId: record.join.parts[0]!.sourceMeetingId,
        };
    }

    const ref = sourceRefOf(record);

    if (!ref) {
        throw new MeetingsStateError(
            "no-transcript-source",
            `${record.id} has no source with a transcript. Link one: ${toolCommand("meetings", "link", record.id, "wisprflow:<id>")}`
        );
    }

    if (!store) {
        return { source: await meetingSource(ref.sourceId), sourceMeetingId: ref.sourceMeetingId };
    }

    return {
        source: await backedSource(ref, store.folder(record.id), { save: options.saveCopy }),
        sourceMeetingId: ref.sourceMeetingId,
    };
}

/** The source behind the copy kept in `folder`; the copy alone when the running code cannot open the source. */
async function backedSource(ref: SourceRef, folder: string, options: { save?: boolean }): Promise<TranscriptSource> {
    try {
        return copyBackedSource(await meetingSource(ref.sourceId), folder, options);
    } catch (error) {
        const copy = isMeetingSourceId(ref.sourceId)
            ? copyOnlySource(ref.sourceId, folder, ref.sourceMeetingId)
            : undefined;

        if (!copy) {
            throw error;
        }

        log.warn({ error, folder }, "the source cannot be opened; the record's own copy answers");
        return copy;
    }
}

/**
 * One recording of a joined record as its own source: its source meeting, with the copy that recording kept in the
 * folder of the record it was behind it. The copy answers when the provider lost the meeting and is never written,
 * so reading one recording (the join, its repair, a polished file's part) never changes the joined record's folder.
 */
export function recordingSource(store: MeetingStore, recording: RecordingRef): Promise<TranscriptSource> {
    return backedSource(recording, store.folder(recording.record), { save: false });
}

/**
 * A joined record's source: its own copy of the joined meeting (`saveJoinedCopy`, written by `join` and
 * `join --repair`), so no read loads a recording's source meeting. The live source answers only the source's own
 * reads (its word list, calendar). A record joined before the join kept that copy is refused with the repair command.
 */
async function joinedRecordSource(record: MeetingRecord, store: MeetingStore | undefined): Promise<TranscriptSource> {
    const owned = store ? ownedJoinedCopy(record, store) : undefined;

    if (!owned) {
        throw uncopiedJoin(record, store);
    }

    const base = await meetingSource(owned.ref.sourceId).catch((error: unknown) => {
        log.warn({ error, meeting: record.id }, "the source cannot be opened; the joined record's own copy answers");
        return isMeetingSourceId(owned.ref.sourceId)
            ? copyOnlySource(owned.ref.sourceId, owned.folder, owned.ref.sourceMeetingId)
            : undefined;
    });

    if (!base) {
        throw new Error(`Unknown source "${owned.ref.sourceId}". Known: ${MEETING_SOURCE_IDS.join(", ")}`);
    }

    const source = ownedCopySource({ ...owned, base });

    if (!source) {
        throw uncopiedJoin(record, store);
    }

    return source;
}

/** Why a joined record has no transcript to read: it keeps no copy of it yet, or it was read without its store. */
function uncopiedJoin(record: MeetingRecord, store: MeetingStore | undefined): Error {
    return new Error(
        store
            ? `${record.id} was joined before the join kept its transcript as its own copy; copy it once: ${toolCommand("meetings", "join", record.id, "--repair")}`
            : `${record.id} is a joined meeting, whose transcript is its own copy; it is read with its meeting store.`
    );
}

/** Where a joined record keeps its own copy, when it keeps one. */
function ownedJoinedCopy(
    record: MeetingRecord,
    store: MeetingStore
): { folder: string; ref: SourceCopyRef } | undefined {
    const parts: JoinPart[] = record.join?.parts ?? [];

    if (parts.length === 0) {
        return undefined;
    }

    const folder = store.folder(record.id);
    const ref = joinedCopyRef(parts);
    return hasSourceCopy(folder, ref) ? { folder, ref } : undefined;
}

/** The linked source's transcript, on its own labels; with `store`, the record's copy answers when the source cannot. */
export async function meetingTranscript(record: MeetingRecord, store?: MeetingStore): Promise<TranscriptEntry[]> {
    const { source, sourceMeetingId } = await linkedSource(record, store);
    return (await source.load(sourceMeetingId)).transcript;
}

function composedTranscript(entries: TranscriptEntry[]): TranscriptEntry[] {
    return entries.map((entry) => ({ ...entry, speaker: entry.speaker.normalize("NFC") }));
}

/**
 * Explicit local-only read for previews: the source registry owns the capability and no remote fallback runs. A joined
 * record reads its own copy, which is local by nature.
 */
export async function localMeetingTranscript(record: MeetingRecord, store?: MeetingStore): Promise<TranscriptEntry[]> {
    if (record.join) {
        const owned = store ? ownedJoinedCopy(record, store) : undefined;
        const copy = owned ? readSourceCopy(owned.folder, "meeting", owned.ref) : undefined;

        if (!copy) {
            throw uncopiedJoin(record, store);
        }

        return copy.value.transcript;
    }

    const ref = sourceRefOf(record);
    if (!ref) {
        throw new MeetingsStateError("no-transcript-source", `${record.id} has no linked local transcript to preview.`);
    }
    if (!isMeetingSourceId(ref.sourceId)) {
        throw new Error(`Unknown source "${ref.sourceId}". Known: ${MEETING_SOURCE_IDS.join(", ")}`);
    }
    return composedTranscript(await MEETING_SOURCES[ref.sourceId].localTranscript(ref.sourceMeetingId));
}
