import { randomUUID } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { chmod, copyFile, link, mkdir, stat, unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import { cloneOrCopy, type Placement } from "@genesiscz/utils/fs/clone";
import { sha256FileAsync } from "@genesiscz/utils/fs/hash";
import { logger } from "@genesiscz/utils/logger";
import {
    MEETING_UNCHANGED,
    type MeetingRecord,
    type MeetingStore,
    type PreservedSourceAudio,
} from "@genesiscz/utils/meetings/record";
import { SOURCE_AUDIO_FOLDER } from "@genesiscz/utils/meetings/source-audio-paths";
import type { MeetingEvidence, TranscriptSource } from "@genesiscz/utils/meetings/sources";
import { localSourceAudio, type SourceRef, sourceRefOf } from "./sources";

const { log } = logger.scoped("meetings-source-audio");

export { SOURCE_AUDIO_FOLDER } from "@genesiscz/utils/meetings/source-audio-paths";

const fingerprints = new Map<string, { source: string; saved: string; sha256: string }>();
const MAX_FINGERPRINTS = 128;

function fingerprint(value: Awaited<ReturnType<typeof stat>>): string {
    return [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].join(":");
}

function sourceStillLinked(record: MeetingRecord, ref: SourceRef): boolean {
    return record.sources[ref.sourceId]?.meetingId === ref.sourceMeetingId;
}

/** Pure lookup: no source read, migration, archive or hash on the playback path. */
export function preservedSourceAudio(
    record: MeetingRecord,
    ref = sourceRefOf(record)
): PreservedSourceAudio | undefined {
    if (!ref) {
        return undefined;
    }
    const audio = record.audio?.sources[ref.sourceId];
    if (!audio || audio.sourceMeetingId !== ref.sourceMeetingId) {
        return undefined;
    }
    try {
        const file = lstatSync(audio.path);
        return file.isFile() && file.size === audio.bytes ? audio : undefined;
    } catch (error) {
        if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
            return undefined;
        }
        throw error;
    }
}

export interface PreserveSourceAudioResult {
    record: MeetingRecord;
    audio: PreservedSourceAudio;
    status: "preserved" | "already-preserved";
    placement?: Exclude<Placement, "declined">;
}

/**
 * Publishes verified private media before its metadata, never overwriting an archived version. A failed record
 * write leaves the complete content-addressed file for a retry. Only unpublished scratch links are removed.
 */
export async function preserveSourceAudio(options: {
    store: MeetingStore;
    meetingId: string;
    ref: SourceRef;
    sourcePath: string;
    signal?: AbortSignal;
    /** The digest an approved plan hashed: a copy of any other bytes is refused before anything is published. */
    expected?: { sha256: string; bytes: number };
    /** Runs after the copy is verified and before it is published, for a check whose answer can change meanwhile. */
    beforePublish?: () => Promise<void>;
}): Promise<PreserveSourceAudioResult> {
    const { store, meetingId, ref, sourcePath, signal, expected } = options;
    const current = store.read(meetingId);
    if (!current || !sourceStillLinked(current, ref)) {
        throw new Error("The meeting's linked source changed before audio preservation; read it again and retry.");
    }
    signal?.throwIfAborted();
    const before = lstatSync(sourcePath);
    if (!before.isFile() || before.size === 0) {
        throw new Error("Source audio must be a nonempty regular file.");
    }
    const key = `${store.root}\0${meetingId}\0${ref.sourceId}`;
    const old = preservedSourceAudio(current, ref);
    const cached = fingerprints.get(key);
    if (
        old &&
        (!expected || expected.sha256 === old.sha256) &&
        cached?.source === fingerprint(before) &&
        cached.sha256 === old.sha256
    ) {
        const saved = await stat(old.path);
        if (cached.saved === fingerprint(saved)) {
            return { record: current, audio: old, status: "already-preserved" };
        }
    }

    const folder = join(store.folder(meetingId), SOURCE_AUDIO_FOLDER);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if (!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink()) {
        throw new Error("The source-audio folder must be a real directory.");
    }
    await chmod(folder, 0o700);
    const pending = join(folder, `.pending-${randomUUID()}`);
    let placement: Exclude<Placement, "declined">;
    try {
        const cloned = cloneOrCopy({ source: sourcePath, destination: pending, mode: 0o600, mayCopy: false });
        if (cloned === "declined") {
            // Native asynchronous copy avoids the shared helper's whole-file fallback allocation.
            await copyFile(sourcePath, pending, constants.COPYFILE_EXCL);
            await chmod(pending, 0o600);
            placement = "copied";
        } else {
            placement = cloned;
        }
        signal?.throwIfAborted();
        const sha256 = await sha256FileAsync(pending, { signal });
        const after = lstatSync(sourcePath);
        const copied = lstatSync(pending);
        if (fingerprint(before) !== fingerprint(after) || copied.size !== before.size) {
            throw new Error(
                "Source audio changed while it was being preserved; retry after the source finishes writing."
            );
        }

        if (expected && (sha256 !== expected.sha256 || copied.size !== expected.bytes)) {
            throw new Error("Source audio changed since the plan approved it; plan again.");
        }

        await options.beforePublish?.();
        const suffix = extname(sourcePath).toLowerCase();
        const extension = /^\.[a-z0-9]{1,6}$/.test(suffix) ? suffix : ".audio";
        const destination = join(folder, `${sha256}${extension}`);
        try {
            // Same-directory hard-link publication is atomic and refuses an existing name.
            await link(pending, destination);
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
                throw error;
            }
            const held = lstatSync(destination);
            if (
                !held.isFile() ||
                held.size !== copied.size ||
                (await sha256FileAsync(destination, { signal })) !== sha256
            ) {
                throw new Error("An existing source-audio file does not match its digest; it was left untouched.");
            }
        }
        signal?.throwIfAborted();
        const audio: PreservedSourceAudio = {
            sourceMeetingId: ref.sourceMeetingId,
            path: destination,
            sha256,
            bytes: copied.size,
            savedAt: new Date().toISOString(),
        };
        let changed = false;
        const record = await store.update(
            meetingId,
            { command: "audio preserve", change: `preserved ${ref.sourceId} source audio (${audio.bytes} bytes)` },
            (next) => {
                if (!sourceStillLinked(next, ref)) {
                    throw new Error("The meeting's linked source changed while audio was being preserved; retry.");
                }
                const previous = next.audio?.sources[ref.sourceId];
                if (
                    previous?.sourceMeetingId === audio.sourceMeetingId &&
                    previous.path === audio.path &&
                    previous.sha256 === audio.sha256 &&
                    previous.bytes === audio.bytes
                ) {
                    return MEETING_UNCHANGED;
                }
                next.audio ??= { sources: {} };
                next.audio.sources[ref.sourceId] = audio;
                changed = true;
            }
        );
        const saved = record.audio?.sources[ref.sourceId];
        if (!saved) {
            throw new Error("Source-audio metadata was not saved.");
        }
        fingerprints.delete(key);
        fingerprints.set(key, { source: fingerprint(after), saved: fingerprint(await stat(saved.path)), sha256 });
        if (fingerprints.size > MAX_FINGERPRINTS) {
            fingerprints.delete(fingerprints.keys().next().value!);
        }
        log.debug(
            {
                meetingId,
                source: ref.sourceId,
                bytes: saved.bytes,
                status: changed ? "preserved" : "already-preserved",
            },
            "source audio preserved"
        );
        return { record, audio: saved, status: changed ? "preserved" : "already-preserved", placement };
    } finally {
        await unlink(pending).catch((error: unknown) => {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
                log.warn({ error, path: pending }, "unpublished source-audio scratch could not be removed");
            }
        });
    }
}

/** Keeps the rest of the source evidence and prefers the owned media, even after the provider removes its file. */
export function withPreservedSourceAudio(
    record: MeetingRecord,
    evidence: MeetingEvidence | null
): MeetingEvidence | null {
    const audio = preservedSourceAudio(record);
    return audio ? { ...(evidence ?? { segments: [], speaking: [], files: [] }), audioPath: audio.path } : evidence;
}

export type SourceAudioSync = {
    record: MeetingRecord;
    status: "preserved" | "already-preserved" | "missing";
};

/** Explicit lifecycle operation, never called by an evidence or playback read. */
export async function syncSourceAudio(options: {
    store: MeetingStore;
    record: MeetingRecord;
    source: TranscriptSource;
    sourceMeetingId: string;
}): Promise<SourceAudioSync> {
    const { store, record, source, sourceMeetingId } = options;
    const ref = { sourceId: source.id, sourceMeetingId };
    if (preservedSourceAudio(record, ref)) {
        return { record, status: "already-preserved" };
    }
    const live = await source.liveRecording();
    if (live?.sourceMeetingId === sourceMeetingId) {
        return { record, status: "missing" };
    }
    const evidence = await source.evidence(sourceMeetingId);
    const candidates = [
        ...(evidence?.audioPath ? [evidence.audioPath] : []),
        ...(await (await localSourceAudio(source.id)).legacyFiles(store.root))
            .filter((file) => file.sourceMeetingId === sourceMeetingId)
            .map((file) => file.path),
    ];
    let sourcePath: string | undefined;
    for (const candidate of candidates) {
        try {
            const file = lstatSync(candidate);
            if (file.isFile() && file.size > 0) {
                sourcePath = candidate;
                break;
            }
        } catch (error) {
            if (!(error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"))) {
                throw error;
            }
        }
    }
    if (!sourcePath) {
        const saved = preservedSourceAudio(record, ref);
        if (saved) {
            return { record, status: "already-preserved" };
        }
        log.warn(
            { meetingId: record.id, source: source.id, sourceMeetingId },
            "No source audio is available to preserve; the record stays linked"
        );
        return { record, status: "missing" };
    }
    const result = await preserveSourceAudio({ store, meetingId: record.id, ref, sourcePath });
    return { record: result.record, status: result.status };
}

/** Cheap list marker: metadata plus file presence/size, never a provider lookup or hash. */
export function sourceAudioSummary(record: MeetingRecord): { sources: string[]; bytes: number } | undefined {
    const sources: string[] = [];
    let bytes = 0;
    for (const [sourceId, audio] of Object.entries(record.audio?.sources ?? {})) {
        if (preservedSourceAudio(record, { sourceId, sourceMeetingId: audio.sourceMeetingId })) {
            sources.push(sourceId);
            bytes += audio.bytes;
        }
    }
    return sources.length > 0 ? { sources, bytes } : undefined;
}
