import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { SOURCE_COPY_FOLDER } from "@genesiscz/utils/meetings/record";
import type {
    MeetingEvidence,
    MeetingSourceId,
    RecordingClock,
    SourceMeeting,
    TranscriptSource,
} from "@genesiscz/utils/meetings/sources";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { z } from "zod";

const { log } = logger.scoped("meetings-source-copy");

/**
 * The record's own copy of what its source answered: the meeting with its transcript, the speaker evidence and the
 * recording clock, one file each under `<record>/source-copy/`. A source is one driver among several (an app on this
 * Mac, an imported export, a remote service), so a record must still show its transcript when that driver cannot
 * answer: the app is gone, the import was removed, the service is down, or the running code has no reader for it.
 */
interface SourceCopyParts {
    meeting: SourceMeeting;
    evidence: MeetingEvidence | null;
    clock: RecordingClock | null;
}
type SourceCopyPart = keyof SourceCopyParts;

export interface SourceCopyRef {
    sourceId: string;
    sourceMeetingId: string;
}

const copyFileSchema = z.object({
    version: z.literal(1),
    sourceId: z.string().min(1),
    sourceMeetingId: z.string().min(1),
    savedAt: z.string(),
    sha256: z.string(),
    value: z.unknown(),
});

function copyPath(folder: string, part: SourceCopyPart): string {
    return join(folder, SOURCE_COPY_FOLDER, `${part}.json`);
}

/**
 * The copy never keeps the provider's audio path: that file belongs to the provider and goes with it, and a path that
 * is gone would offer sound tracks that cannot play. The record's own audio is its preserved source audio
 * (`audio.sources`), which the opened meeting adds itself.
 */
function withoutProviderAudio<T>(value: T): T {
    if (value === null || typeof value !== "object" || !("audioPath" in value)) {
        return value;
    }

    const { audioPath: _provider, ...rest } = value;
    // The same object without one optional key: still the part's type.
    return rest as T;
}

function digest(value: unknown): string {
    return createHash("sha256").update(SafeJSON.stringify(value)).digest("hex");
}

/** The saved copy of one part for this source meeting; undefined when none is saved or it names another meeting. */
export function readSourceCopy<P extends SourceCopyPart>(
    folder: string,
    part: P,
    ref: SourceCopyRef
): { sha256: string; savedAt: string; value: SourceCopyParts[P] } | undefined {
    const path = copyPath(folder, part);

    if (!existsSync(path)) {
        return undefined;
    }

    const parsed = copyFileSchema.safeParse(SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }));

    if (!parsed.success) {
        log.warn({ path, issues: parsed.error.issues.length }, "the record's source copy is unreadable; it is ignored");
        return undefined;
    }

    const file = parsed.data;

    if (file.sourceId !== ref.sourceId || file.sourceMeetingId !== ref.sourceMeetingId) {
        return undefined;
    }

    // This module is the only writer of the file, and it writes the value the source returned for this part.
    return { sha256: file.sha256, savedAt: file.savedAt, value: file.value as SourceCopyParts[P] };
}

/** Saves one part when it differs from the saved copy. Returns true when the file was written. */
export function saveSourceCopy<P extends SourceCopyPart>(
    folder: string,
    part: P,
    ref: SourceCopyRef,
    value: SourceCopyParts[P]
): boolean {
    const kept = withoutProviderAudio(value);
    const sha256 = digest(kept);

    if (readSourceCopy(folder, part, ref)?.sha256 === sha256) {
        return false;
    }

    const file = { version: 1, ...ref, savedAt: new Date().toISOString(), sha256, value: kept };
    atomicWriteFileSync(copyPath(folder, part), `${SafeJSON.stringify(file)}\n`);
    log.debug({ folder, part, sourceMeetingId: ref.sourceMeetingId }, "the record's source copy was refreshed");
    return true;
}

/**
 * Saves every part the source answers now (`new`, `link`, a refresh). The meeting is the one the caller already
 * loaded. A failed evidence or clock read keeps the older copy of that part.
 */
export async function captureSourceCopy(options: {
    folder: string;
    source: TranscriptSource;
    meeting: SourceMeeting;
}): Promise<void> {
    const { folder, source, meeting } = options;
    const ref = { sourceId: source.id, sourceMeetingId: meeting.sourceMeetingId };
    saveSourceCopy(folder, "meeting", ref, meeting);

    const [evidence, clock] = await Promise.allSettled([
        source.evidence(meeting.sourceMeetingId),
        source.recordingClock(meeting.sourceMeetingId),
    ]);

    if (evidence.status === "fulfilled") {
        keep(folder, "evidence", ref, evidence.value);
    } else {
        log.debug({ error: evidence.reason, folder }, "no evidence to copy now");
    }

    if (clock.status === "fulfilled") {
        keep(folder, "clock", ref, clock.value);
    } else {
        log.debug({ error: clock.reason, folder }, "no recording clock to copy now");
    }
}

/**
 * Saves a part that may be null. A null after a saved value means the source lost the data (an import removed),
 * not that the meeting never had it, so the saved value stays and is returned.
 */
function keep<P extends "evidence" | "clock">(
    folder: string,
    part: P,
    ref: SourceCopyRef,
    value: SourceCopyParts[P]
): SourceCopyParts[P] {
    if (value === null) {
        const saved = readSourceCopy(folder, part, ref);

        if (saved && saved.value !== null) {
            log.info({ folder, part }, "the source answers no data now; the record's own copy is used");
            return saved.value;
        }
    }

    saveSourceCopy(folder, part, ref, value);
    return value;
}

/** The copy's token for `revision` when the source cannot answer one. */
function copyRevision(folder: string, ref: SourceCopyRef): string | undefined {
    const saved = readSourceCopy(folder, "meeting", ref);
    return saved ? `source-copy:${saved.sha256}` : undefined;
}

/**
 * The source, with the record's copy behind the reads a record needs: each answer refreshes the copy, and a read that
 * fails answers from the copy when one is saved. Without a copy the source's error is thrown as before.
 *
 * With a saved copy, the source is read only from this Mac (`remote: false`): a plain read (`show`, `transcript`, the
 * window) never dials a remote service or asks for the vault key. `new`, `link` and a refresh read the source directly
 * and may go remote, which brings a server-only change into the copy (D41, 2026-11-20).
 */
export function copyBackedSource(source: TranscriptSource, folder: string): TranscriptSource {
    const refOf = (sourceMeetingId: string) => ({ sourceId: source.id, sourceMeetingId });
    const reach = (sourceMeetingId: string) =>
        readSourceCopy(folder, "meeting", refOf(sourceMeetingId)) ? { remote: false } : {};

    async function backed<P extends SourceCopyPart>(
        part: P,
        sourceMeetingId: string,
        read: () => Promise<SourceCopyParts[P]>,
        save: (value: SourceCopyParts[P]) => SourceCopyParts[P]
    ): Promise<SourceCopyParts[P]> {
        let value: SourceCopyParts[P];

        try {
            value = await read();
        } catch (error) {
            const saved = readSourceCopy(folder, part, refOf(sourceMeetingId));

            if (!saved) {
                throw error;
            }

            log.warn({ error, folder, part }, `${source.label} cannot answer; the record's own copy is used`);
            return saved.value;
        }

        try {
            return save(value);
        } catch (error) {
            // A copy that cannot be written (a full disk) must not hide an answer the source gave.
            log.warn({ error, folder, part }, "the record's source copy could not be written");
            return value;
        }
    }

    return {
        ...source,
        load: (id) =>
            backed(
                "meeting",
                id,
                () => source.load(id, reach(id)),
                (meeting) => {
                    saveSourceCopy(folder, "meeting", refOf(id), meeting);
                    return meeting;
                }
            ),
        evidence: (id) =>
            backed(
                "evidence",
                id,
                () => source.evidence(id),
                (evidence) => keep(folder, "evidence", refOf(id), evidence)
            ),
        recordingClock: (id) =>
            backed(
                "clock",
                id,
                () => source.recordingClock(id, reach(id)),
                (clock) => keep(folder, "clock", refOf(id), clock)
            ),
        revision: async (id) => {
            try {
                return await source.revision(id);
            } catch (error) {
                const token = copyRevision(folder, refOf(id));

                if (token === undefined) {
                    throw error;
                }

                log.debug({ error, folder }, "the source gave no revision; the record's copy answers it");
                return token;
            }
        },
    };
}

/**
 * A source that answers only from the record's copy, for a record whose source code cannot be opened (the running
 * checkout has no reader for it). Undefined when the record has no saved meeting.
 */
export function copyOnlySource(
    sourceId: MeetingSourceId,
    folder: string,
    sourceMeetingId: string
): TranscriptSource | undefined {
    const ref = { sourceId, sourceMeetingId };
    const meeting = readSourceCopy(folder, "meeting", ref);

    if (!meeting) {
        return undefined;
    }

    const missing = (part: SourceCopyPart) =>
        new Error(`${sourceId} cannot be read here, and the record keeps no copy of its ${part}`);
    const reason = `${sourceId} cannot be read by this code; the record answers from its own copy`;

    return {
        id: sourceId,
        label: `${sourceId} (the record's copy)`,
        load: async (id) => {
            const saved = readSourceCopy(folder, "meeting", { sourceId, sourceMeetingId: id });

            if (!saved) {
                throw missing("meeting");
            }

            return saved.value;
        },
        revision: async (id) => copyRevision(folder, { sourceId, sourceMeetingId: id }) ?? null,
        describe: () => {
            throw new Error(reason);
        },
        // The copy keeps one meeting's answers: no word list, no live recording, no calendar, no folders.
        dictionary: async () => [],
        recordingClock: async (id) => readSourceCopy(folder, "clock", { sourceId, sourceMeetingId: id })?.value ?? null,
        evidence: async (id) => readSourceCopy(folder, "evidence", { sourceId, sourceMeetingId: id })?.value ?? null,
        liveRecording: async () => null,
        calendarEntries: async () => ({ ok: false, from: sourceId, reason }),
        folders: async () => null,
        meetingsBetween: async () => null,
        meetingFolders: async () => null,
        folderWrite: { supported: false, reason, manualStep: "Open the meeting where its source can be read." },
    };
}
