import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
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

/** What a copy file says about itself, without its value. */
interface CopyHeader {
    sourceId: string;
    sourceMeetingId: string;
    savedAt: string;
    sha256: string;
}

/**
 * The bytes read for a copy's header. `saveSourceCopy` writes the header keys before the value, so a check that needs
 * only the digest or the meeting it names (every read of a record) reads this much, not the whole transcript.
 */
const HEADER_BYTES = 4096;
const JSON_STRING = String.raw`"(?:[^"\\]|\\.)*"`;
const HEADER_RE = new RegExp(
    `^\\{"version":1,"sourceId":(${JSON_STRING}),"sourceMeetingId":(${JSON_STRING}),"savedAt":(${JSON_STRING}),"sha256":"([0-9a-f]{64})","value":`
);

function jsonString(literal: string): string | undefined {
    const value: unknown = SafeJSON.parse(literal, { strict: true });
    return typeof value === "string" ? value : undefined;
}

/** The whole copy file, or undefined when it is missing, cut short or of another shape (a valid answer then replaces it). */
function readCopyFile(path: string): z.infer<typeof copyFileSchema> | undefined {
    if (!existsSync(path)) {
        return undefined;
    }

    try {
        const parsed = copyFileSchema.safeParse(SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }));

        if (parsed.success) {
            return parsed.data;
        }

        log.warn({ path, issues: parsed.error.issues.length }, "the record's source copy is unreadable; it is ignored");
    } catch (error) {
        log.warn({ error, path }, "the record's source copy is unreadable; it is ignored");
    }

    return undefined;
}

/** The header from the first bytes of the file; a file written another way is read in full. */
function readCopyHeader(path: string): CopyHeader | undefined {
    let head: string;
    // A file cut short (a full disk under an older writer) loses its closing brace: it is read in full and ignored.
    let whole: boolean;

    try {
        const fd = openSync(path, "r");

        try {
            const buffer = Buffer.alloc(HEADER_BYTES);
            const size = fstatSync(fd).size;
            head = buffer.subarray(0, readSync(fd, buffer, 0, HEADER_BYTES, 0)).toString("utf8");
            const tail = Buffer.alloc(2);
            whole = size >= 2 && readSync(fd, tail, 0, 2, size - 2) === 2 && tail.toString("utf8") === "}\n";
        } finally {
            closeSync(fd);
        }
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return undefined;
        }

        log.warn({ error, path }, "the record's source copy is unreadable; it is ignored");
        return undefined;
    }

    const match = whole ? head.match(HEADER_RE) : null;
    const [sourceId, sourceMeetingId, savedAt] = match ? [match[1], match[2], match[3]].map(jsonString) : [];

    if (match?.[4] && sourceId !== undefined && sourceMeetingId !== undefined && savedAt !== undefined) {
        return { sourceId, sourceMeetingId, savedAt, sha256: match[4] };
    }

    const file = readCopyFile(path);
    return file
        ? { sourceId: file.sourceId, sourceMeetingId: file.sourceMeetingId, savedAt: file.savedAt, sha256: file.sha256 }
        : undefined;
}

/** The header of one saved part for this source meeting; undefined when none is saved or it names another meeting. */
function copyHeader(folder: string, part: SourceCopyPart, ref: SourceCopyRef): CopyHeader | undefined {
    const header = readCopyHeader(copyPath(folder, part));
    return header?.sourceId === ref.sourceId && header.sourceMeetingId === ref.sourceMeetingId ? header : undefined;
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
    const file = readCopyFile(copyPath(folder, part));

    if (!file || file.sourceId !== ref.sourceId || file.sourceMeetingId !== ref.sourceMeetingId) {
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

    if (copyHeader(folder, part, ref)?.sha256 === sha256) {
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
    saveSourceCopy(folder, "meeting", { sourceId: source.id, sourceMeetingId: meeting.sourceMeetingId }, meeting);
    await captureEvidenceAndClock({ folder, source, sourceMeetingId: meeting.sourceMeetingId });
}

/** Saves the evidence and the clock the source answers now; a failed read keeps the older copy of that part. */
async function captureEvidenceAndClock(options: {
    folder: string;
    source: TranscriptSource;
    sourceMeetingId: string;
}): Promise<void> {
    const { folder, source, sourceMeetingId } = options;
    const ref = { sourceId: source.id, sourceMeetingId };
    const [evidence, clock] = await Promise.allSettled([
        source.evidence(sourceMeetingId),
        source.recordingClock(sourceMeetingId),
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

/** The copy's token for `revision` when the source cannot answer one: the meeting and the clock it was read with. */
function copyRevision(folder: string, ref: SourceCopyRef): string | undefined {
    const meeting = copyHeader(folder, "meeting", ref);
    const clock = copyHeader(folder, "clock", ref);
    return meeting ? `source-copy:${meeting.sha256}${clock ? `:${clock.sha256}` : ""}` : undefined;
}

/**
 * The source, with the record's copy behind the reads a record needs: each answer refreshes the copy, and a read that
 * fails answers from the copy when one is saved. Without a copy the source's error is thrown as before.
 *
 * With a saved copy of a part, that part is read from the source only on this Mac (`remote: false`): a plain read
 * (`show`, `transcript`, the window) never dials a remote service or asks for the vault key. `new`, `link` and a
 * refresh read the source directly and may go remote, which brings a server-only change into the copy (D41,
 * 2026-11-20). The first read that saves the meeting also saves the evidence and the clock while the source may still
 * go remote, so a record made before this copy existed keeps all three parts.
 *
 * `save: false` answers from the copy when the source cannot, but writes nothing (a probe that must not change the
 * record).
 */
export function copyBackedSource(
    source: TranscriptSource,
    folder: string,
    options: { save?: boolean } = {}
): TranscriptSource {
    const saving = options.save ?? true;
    const refOf = (sourceMeetingId: string) => ({ sourceId: source.id, sourceMeetingId });
    const reach = (part: SourceCopyPart, sourceMeetingId: string) =>
        copyHeader(folder, part, refOf(sourceMeetingId)) ? { remote: false } : {};

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

        if (!saving) {
            return value;
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
        load: async (id) => {
            const first = saving && !copyHeader(folder, "meeting", refOf(id));
            const meeting = await backed(
                "meeting",
                id,
                () => source.load(id, reach("meeting", id)),
                (loaded) => {
                    saveSourceCopy(folder, "meeting", refOf(id), loaded);
                    return loaded;
                }
            );

            if (first && copyHeader(folder, "meeting", refOf(id))) {
                await captureEvidenceAndClock({ folder, source, sourceMeetingId: id }).catch((error: unknown) => {
                    log.warn({ error, folder }, "the record's first evidence and clock copy could not be saved");
                });
            }

            return meeting;
        },
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
                () => source.recordingClock(id, reach("clock", id)),
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

/** A source meeting id as a folder name: itself when it is a plain name, else its digest. */
function folderName(id: string): string {
    return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) ? id : createHash("sha256").update(id).digest("hex");
}

/**
 * Where a joined record keeps one recording's own copy (what that recording's source answered alone), beside the
 * joined copy that took the place of the first recording's copy in its folder. It is a folder that holds a
 * `source-copy/` folder, as a record folder does, so every function here reads it; it sits inside the joined record's
 * own `source-copy/`, so the watchers and the window's revisions skip it as they skip the copy.
 */
export function recordingCopyFolder(recordFolder: string, sourceMeetingId: string): string {
    return join(recordFolder, SOURCE_COPY_FOLDER, "recordings", folderName(sourceMeetingId));
}

/** Whether the folder keeps a copy of the meeting `ref` names: a header read, not the transcript. */
export function hasSourceCopy(folder: string, ref: SourceCopyRef): boolean {
    return copyHeader(folder, "meeting", ref) !== undefined;
}

/**
 * The source of a record that owns its copy: a joined record (`meetings join`), whose meeting no single source can
 * answer. The meeting, its evidence, its clock, its revision and its folders come only from the copy saved under
 * `ref`, whatever id a caller asks with, so no read loads a source meeting. `base` answers the source's own reads (its
 * word list, describe, calendar, live recording, folder list): the live source, or `copyOnlySource` when the running
 * code cannot open it. Undefined when the folder keeps no copy under `ref`.
 */
export function ownedCopySource(options: {
    folder: string;
    ref: SourceCopyRef;
    base: TranscriptSource;
}): TranscriptSource | undefined {
    const { folder, ref, base } = options;

    if (!hasSourceCopy(folder, ref)) {
        return undefined;
    }

    const meeting = (): SourceMeeting => {
        const saved = readSourceCopy(folder, "meeting", ref);

        if (!saved) {
            throw new Error(
                `The record's own copy of its meeting is gone or unreadable (${folder}); restore it from the backup.`
            );
        }

        return saved.value;
    };

    return {
        ...base,
        load: async () => meeting(),
        evidence: async () => readSourceCopy(folder, "evidence", ref)?.value ?? null,
        recordingClock: async () => readSourceCopy(folder, "clock", ref)?.value ?? null,
        revision: async () => copyRevision(folder, ref) ?? null,
        meetingFolders: async () => meeting().folders,
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
    if (!copyHeader(folder, "meeting", { sourceId, sourceMeetingId })) {
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
