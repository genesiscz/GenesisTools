import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { sha256FileAsync } from "@genesiscz/utils/fs/hash";
import { logger } from "@genesiscz/utils/logger";
import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import type {
    LocalAudioFile,
    LocalAudioMeeting,
    LocalSourceAudio,
    MeetingSourceId,
} from "@genesiscz/utils/meetings/sources";
import { MEETING_SOURCE_IDS } from "@genesiscz/utils/meetings/sources";
import { z } from "zod";
import { preservedSourceAudio, preserveSourceAudio } from "./source-audio";

const { log } = logger.scoped("meetings-audio-discovery");

export type { LocalAudioFile, LocalAudioMeeting, LocalSourceAudio };

function linkedRecords(store: MeetingStore, sourceId: string, sourceMeetingId: string): MeetingRecord[] {
    return store.list().filter((record) => record.sources[sourceId]?.meetingId === sourceMeetingId);
}

export async function withSourceAudioRecordLock<T>(options: {
    store: MeetingStore;
    sourceId: string;
    sourceMeetingId: string;
    fn: () => Promise<T>;
}): Promise<T> {
    const key = createHash("sha256").update(`${options.sourceId}\0${options.sourceMeetingId}`).digest("hex");
    return options.store.storage.withFileLock({
        file: join(options.store.root, `.source-audio-${key}`),
        fn: options.fn,
    });
}

/** All automatic discovery and explicit backfill creation share this source-id lock and reread under it. */
export async function sourceAudioRecords(options: {
    store: MeetingStore;
    source: LocalSourceAudio;
    sourceMeetingId: string;
}): Promise<MeetingRecord[]> {
    const { store, source, sourceMeetingId } = options;
    return withSourceAudioRecordLock({
        store,
        sourceId: source.id,
        sourceMeetingId,
        fn: async () => {
            const existing = linkedRecords(store, source.id, sourceMeetingId);
            if (existing.length) {
                return existing;
            }
            const meeting = await source.load(sourceMeetingId);
            if (!meeting || meeting.sourceMeetingId !== sourceMeetingId) {
                return [];
            }
            const record = await store.create(
                {
                    title: meeting.title,
                    start: meeting.start,
                    end: meeting.end,
                    createdBy: "link",
                    sources: { [source.id]: { meetingId: sourceMeetingId } },
                    participants: meeting.participants,
                    calendar: meeting.calendar,
                },
                { command: "audio discover", change: `created to preserve ${source.id} ${sourceMeetingId}` }
            );
            return [record];
        },
    });
}

/** Filesystem discovery is cheap enough for every watch tick. Already preserved records need no metadata load. */
export async function discoverSourceAudio(options: {
    store: MeetingStore;
    source: LocalSourceAudio;
    liveSourceMeetingId?: string;
}): Promise<{ preserved: number; pending: number }> {
    const { store, source, liveSourceMeetingId } = options;
    const files = await source.files();
    let preserved = 0;
    let pending = 0;
    for (const file of files) {
        if (file.sourceMeetingId === liveSourceMeetingId) {
            pending += 1;
            continue;
        }
        const ref = { sourceId: source.id, sourceMeetingId: file.sourceMeetingId };
        const existing = linkedRecords(store, source.id, file.sourceMeetingId);
        try {
            const currentFile = await lstat(file.path);
            const upToDate = (record: MeetingRecord) => {
                const audio = preservedSourceAudio(record, ref);
                return audio && audio.bytes === currentFile.size && currentFile.mtimeMs <= Date.parse(audio.savedAt);
            };
            if (existing.length && existing.every(upToDate)) {
                continue;
            }
            const records = existing.length ? existing : await sourceAudioRecords({ store, source, ...file });
            if (!records.length) {
                pending += 1;
            }
            for (const record of records) {
                if (!upToDate(record)) {
                    const result = await preserveSourceAudio({
                        store,
                        meetingId: record.id,
                        ref,
                        sourcePath: file.path,
                    });
                    preserved += result.status === "preserved" ? 1 : 0;
                }
            }
        } catch (error) {
            pending += 1;
            log.warn({ error, source: source.id, sourceMeetingId: file.sourceMeetingId }, "audio discovery will retry");
        }
    }
    return { preserved, pending };
}

export interface PlannedAudioFile extends LocalAudioFile {
    origin: "provider" | "legacy";
    bytes: number;
    sha256: string;
}

export interface SourceAudioPlanEntry {
    sourceId: MeetingSourceId;
    sourceMeetingId: string;
    title?: string;
    recordIds: string[];
    status: "preserve" | "create" | "preserved" | "missing" | "conflict" | "unmatched" | "live";
    files: PlannedAudioFile[];
}

export interface SourceAudioPlan {
    version: 1;
    meetingsRoot: string;
    entries: SourceAudioPlanEntry[];
}

export const sourceAudioPlanSchema = z.object({
    version: z.literal(1),
    meetingsRoot: z.string().min(1),
    entries: z.array(
        z.object({
            sourceId: z.enum(MEETING_SOURCE_IDS),
            sourceMeetingId: z.string().min(1),
            title: z.string().optional(),
            recordIds: z.array(z.string().min(1)),
            status: z.enum(["preserve", "create", "preserved", "missing", "conflict", "unmatched", "live"]),
            files: z.array(
                z.object({
                    sourceMeetingId: z.string().min(1),
                    path: z.string().min(1),
                    origin: z.enum(["provider", "legacy"]),
                    bytes: z.number().int().positive(),
                    sha256: z.string().regex(/^[a-f0-9]{64}$/),
                })
            ),
        })
    ),
});

/** Hash every available provider and stopgap copy before offering an explicit apply. This operation only reads. */
export async function planSourceAudio(options: {
    store: MeetingStore;
    sources: LocalSourceAudio[];
    live?: Partial<Record<MeetingSourceId, string>>;
}): Promise<SourceAudioPlan> {
    const entries: SourceAudioPlanEntry[] = [];
    const records = options.store.list();
    for (const source of options.sources) {
        const catalog = new Map((await source.catalog()).map((meeting) => [meeting.sourceMeetingId, meeting]));
        const grouped = new Map<string, PlannedAudioFile[]>();
        for (const origin of ["provider", "legacy"] as const) {
            const files = origin === "provider" ? await source.files() : await source.legacyFiles(options.store.root);
            for (const file of files) {
                if (options.live?.[source.id] === file.sourceMeetingId) {
                    grouped.set(file.sourceMeetingId, []);
                    continue;
                }
                const stat = await lstat(file.path);
                if (!stat.isFile() || stat.size === 0) {
                    continue;
                }
                const sha256 = await sha256FileAsync(file.path);
                const after = await lstat(file.path);
                if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) {
                    throw new Error(`Source audio changed while planning: ${file.path}`);
                }
                const group = grouped.get(file.sourceMeetingId) ?? [];
                group.push({ ...file, origin, bytes: stat.size, sha256 });
                grouped.set(file.sourceMeetingId, group);
            }
        }
        const ids = new Set([
            ...catalog.keys(),
            ...grouped.keys(),
            ...records.flatMap((record) => {
                const id = record.sources[source.id]?.meetingId;
                return typeof id === "string" ? [id] : [];
            }),
        ]);
        for (const sourceMeetingId of [...ids].sort()) {
            const held = records.filter((record) => record.sources[source.id]?.meetingId === sourceMeetingId);
            const files = grouped.get(sourceMeetingId) ?? [];
            const ref = { sourceId: source.id, sourceMeetingId };
            const owned = await Promise.all(
                held.map(async (record) => {
                    const audio = preservedSourceAudio(record, ref);
                    return audio && (await sha256FileAsync(audio.path)) === audio.sha256 ? audio : undefined;
                })
            );
            const saved = owned.length > 0 && owned.every(Boolean);
            const digests = new Set([
                ...files.map((file) => `${file.sha256}:${file.bytes}`),
                ...owned.flatMap((audio) => (audio ? [`${audio.sha256}:${audio.bytes}`] : [])),
            ]);
            const status =
                options.live?.[source.id] === sourceMeetingId
                    ? "live"
                    : digests.size > 1
                      ? "conflict"
                      : saved
                        ? "preserved"
                        : files.length === 0
                          ? "missing"
                          : held.length
                            ? "preserve"
                            : catalog.has(sourceMeetingId)
                              ? "create"
                              : "unmatched";
            entries.push({
                sourceId: source.id,
                sourceMeetingId,
                title: catalog.get(sourceMeetingId)?.title,
                recordIds: held.map((record) => record.id),
                status,
                files,
            });
        }
    }
    return { version: 1, meetingsRoot: options.store.root, entries };
}

/** Explicit writes only. Revalidate inputs, live state and record links; retries use current persisted state. */
export async function applySourceAudioPlan(options: {
    store: MeetingStore;
    plan: SourceAudioPlan;
    sources: LocalSourceAudio[];
    live?: Partial<Record<MeetingSourceId, string>>;
}): Promise<Array<{ sourceId: string; sourceMeetingId: string; recordId: string; status: string }>> {
    const { store, plan } = options;
    sourceAudioPlanSchema.parse(plan);
    if (plan.version !== 1 || plan.meetingsRoot !== store.root) {
        throw new Error("The audio plan belongs to a different meetings store.");
    }
    const results: Array<{ sourceId: string; sourceMeetingId: string; recordId: string; status: string }> = [];
    for (const entry of plan.entries) {
        if (!["preserve", "create", "preserved"].includes(entry.status)) {
            continue;
        }
        if (options.live?.[entry.sourceId] === entry.sourceMeetingId) {
            throw new Error(`The source is recording again: ${entry.sourceMeetingId}`);
        }
        const source = options.sources.find((candidate) => candidate.id === entry.sourceId);
        if (!source) {
            throw new Error(`Source unavailable: ${entry.sourceId}`);
        }
        const digests = new Set(entry.files.map((file) => `${file.sha256}:${file.bytes}`));
        if (digests.size > 1 || entry.files.some((file) => file.sourceMeetingId !== entry.sourceMeetingId)) {
            throw new Error(`The audio plan contains conflicting source files: ${entry.sourceMeetingId}`);
        }
        const available = [...(await source.files()), ...(await source.legacyFiles(store.root))];
        for (const file of entry.files) {
            if (
                !available.some(
                    (candidate) => candidate.sourceMeetingId === entry.sourceMeetingId && candidate.path === file.path
                )
            ) {
                throw new Error(`Audio plan file is no longer available: ${file.path}`);
            }
            const stat = await lstat(file.path);
            if (!stat.isFile() || stat.size !== file.bytes || (await sha256FileAsync(file.path)) !== file.sha256) {
                throw new Error(`Audio changed since the plan: ${file.path}`);
            }
        }
        const ref = { sourceId: source.id, sourceMeetingId: entry.sourceMeetingId };
        for (const id of entry.recordIds) {
            if (store.read(id)?.sources[source.id]?.meetingId !== entry.sourceMeetingId) {
                throw new Error(`The planned record's linked source changed: ${id}`);
            }
        }
        const records = await sourceAudioRecords({ store, source, sourceMeetingId: entry.sourceMeetingId });
        for (const record of records) {
            const owned = preservedSourceAudio(record, ref);
            if (owned) {
                if ((await sha256FileAsync(owned.path)) !== owned.sha256) {
                    throw new Error(`Owned audio changed since the plan: ${record.id}`);
                }
                results.push({ ...ref, recordId: record.id, status: "already-preserved" });
                continue;
            }
            const file = entry.files[0];
            if (!file) {
                throw new Error(`No planned source audio for ${entry.sourceMeetingId}`);
            }
            const result = await preserveSourceAudio({ store, meetingId: record.id, ref, sourcePath: file.path });
            results.push({ ...ref, recordId: record.id, status: result.status });
        }
    }
    return results;
}
