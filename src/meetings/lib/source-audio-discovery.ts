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
    SourceMeeting,
} from "@genesiscz/utils/meetings/sources";
import { MEETING_SOURCE_IDS } from "@genesiscz/utils/meetings/sources";
import { z } from "zod";
import { preservedSourceAudio, preserveSourceAudio } from "./source-audio";

const { log } = logger.scoped("meetings-audio-discovery");

export type { LocalAudioFile, LocalAudioMeeting, LocalSourceAudio };

/**
 * The source meeting a provider records right now. A pass hashes and copies for minutes, so a caller asks it again
 * right before each copy and once more before publication; tests inject it together with their isolated adapters.
 */
export type LiveSourceMeeting = (sourceId: MeetingSourceId) => Promise<string | undefined>;

/** One store snapshot per pass: the records linked to each of the source's meetings. */
function linkedIndex(records: MeetingRecord[], sourceId: string): Map<string, MeetingRecord[]> {
    const index = new Map<string, MeetingRecord[]>();
    for (const record of records) {
        const id = record.sources[sourceId]?.meetingId;
        if (typeof id !== "string") {
            continue;
        }

        const list = index.get(id);

        if (list) {
            list.push(record);
        } else {
            index.set(id, [record]);
        }
    }

    return index;
}

async function refuseLive(options: { live?: LiveSourceMeeting; sourceId: MeetingSourceId; sourceMeetingId: string }) {
    if ((await options.live?.(options.sourceId)) === options.sourceMeetingId) {
        throw new Error(`The source is recording again: ${options.sourceMeetingId}`);
    }
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
    /** The provider's metadata when the caller already read it; read under the lock otherwise. */
    meeting?: SourceMeeting;
}): Promise<MeetingRecord[]> {
    const { store, source, sourceMeetingId } = options;
    return withSourceAudioRecordLock({
        store,
        sourceId: source.id,
        sourceMeetingId,
        fn: async () => {
            const existing = linkedIndex(store.list(), source.id).get(sourceMeetingId) ?? [];
            if (existing.length) {
                return existing;
            }
            const meeting = options.meeting ?? (await source.load(sourceMeetingId));
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

/**
 * Filesystem discovery is cheap enough for every watch tick: one store snapshot per pass, no metadata load for a
 * preserved record, and one provider row only for a file with no record yet. The locked reread stays for record
 * creation. The live recording is asked again right before each copy and before its publication.
 */
export async function discoverSourceAudio(options: {
    store: MeetingStore;
    source: LocalSourceAudio;
    live?: LiveSourceMeeting;
}): Promise<{ preserved: number; pending: number }> {
    const { store, source, live } = options;
    const files = await source.files();
    let preserved = 0;
    let pending = 0;
    if (!files.length) {
        return { preserved, pending };
    }

    const passLive = await live?.(source.id);
    const linked = linkedIndex(store.list(), source.id);
    for (const file of files) {
        if (file.sourceMeetingId === passLive) {
            pending += 1;
            continue;
        }
        const ref = { sourceId: source.id, sourceMeetingId: file.sourceMeetingId };
        const existing = linked.get(file.sourceMeetingId) ?? [];
        try {
            const currentFile = await lstat(file.path);
            const upToDate = (record: MeetingRecord) => {
                const audio = preservedSourceAudio(record, ref);
                return audio && audio.bytes === currentFile.size && currentFile.mtimeMs <= Date.parse(audio.savedAt);
            };
            if (existing.length && existing.every(upToDate)) {
                continue;
            }

            if ((await live?.(source.id)) === file.sourceMeetingId) {
                pending += 1;
                continue;
            }
            // An orphan file (no local metadata) stays pending without the source lock or another store read.
            const meeting = existing.length ? undefined : ((await source.load(file.sourceMeetingId)) ?? undefined);
            if (!existing.length && meeting?.sourceMeetingId !== file.sourceMeetingId) {
                pending += 1;
                continue;
            }
            const records = existing.length
                ? existing
                : await sourceAudioRecords({ store, source, sourceMeetingId: file.sourceMeetingId, meeting });
            if (!records.length) {
                pending += 1;
            }
            const current: MeetingRecord[] = [];
            for (const record of records) {
                if (upToDate(record)) {
                    current.push(record);
                    continue;
                }
                const result = await preserveSourceAudio({
                    store,
                    meetingId: record.id,
                    ref,
                    sourcePath: file.path,
                    beforePublish: () => refuseLive({ live, ...ref }),
                });
                current.push(result.record);
                preserved += result.status === "preserved" ? 1 : 0;
            }
            linked.set(file.sourceMeetingId, current);
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
    live?: LiveSourceMeeting;
}): Promise<SourceAudioPlan> {
    const entries: SourceAudioPlanEntry[] = [];
    const records = options.store.list();
    for (const source of options.sources) {
        const live = await options.live?.(source.id);
        const linked = linkedIndex(records, source.id);
        const grouped = new Map<string, PlannedAudioFile[]>();
        for (const origin of ["provider", "legacy"] as const) {
            const files = origin === "provider" ? await source.files() : await source.legacyFiles(options.store.root);
            for (const file of files) {
                if (live === file.sourceMeetingId) {
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
        // A provider meeting with neither a local file nor a record has nothing to reconcile, so the plan reads no
        // catalog: it asks the provider for one row only where a file has no record yet (create or unmatched).
        const ids = new Set([...grouped.keys(), ...linked.keys()]);
        const rows: Array<{
            sourceMeetingId: string;
            held: MeetingRecord[];
            files: PlannedAudioFile[];
            settled: SourceAudioPlanEntry["status"] | undefined;
        }> = [];
        for (const sourceMeetingId of [...ids].sort()) {
            const held = linked.get(sourceMeetingId) ?? [];
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
            const settled =
                live === sourceMeetingId
                    ? "live"
                    : digests.size > 1
                      ? "conflict"
                      : saved
                        ? "preserved"
                        : files.length === 0
                          ? "missing"
                          : held.length
                            ? "preserve"
                            : undefined;
            rows.push({ sourceMeetingId, held, files, settled });
        }
        // The provider rows the unsettled meetings need are independent reads: they load together.
        const meetings = await Promise.all(
            rows.map((row) => (row.settled ? undefined : source.load(row.sourceMeetingId)))
        );
        rows.forEach(({ sourceMeetingId, held, files, settled }, index) => {
            const meeting = meetings[index];
            const status = settled ?? (meeting?.sourceMeetingId === sourceMeetingId ? "create" : "unmatched");
            entries.push({
                sourceId: source.id,
                sourceMeetingId,
                title: meeting?.title ?? held[0]?.title,
                recordIds: held.map((record) => record.id),
                status,
                files,
            });
        });
    }
    return { version: 1, meetingsRoot: options.store.root, entries };
}

/** Explicit writes only. Revalidate inputs, live state and record links; retries use current persisted state. */
export async function applySourceAudioPlan(options: {
    store: MeetingStore;
    plan: SourceAudioPlan;
    sources: LocalSourceAudio[];
    live?: LiveSourceMeeting;
}): Promise<Array<{ sourceId: string; sourceMeetingId: string; recordId: string; status: string }>> {
    const { store, plan, live } = options;
    sourceAudioPlanSchema.parse(plan);
    if (plan.version !== 1 || plan.meetingsRoot !== store.root) {
        throw new Error("The audio plan belongs to a different meetings store.");
    }
    const results: Array<{ sourceId: string; sourceMeetingId: string; recordId: string; status: string }> = [];
    for (const entry of plan.entries) {
        if (!["preserve", "create", "preserved"].includes(entry.status)) {
            continue;
        }
        await refuseLive({ live, sourceId: entry.sourceId, sourceMeetingId: entry.sourceMeetingId });
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
        const approved = new Set(digests);
        for (const id of entry.recordIds) {
            const record = store.read(id);
            if (record?.sources[source.id]?.meetingId !== entry.sourceMeetingId) {
                throw new Error(`The planned record's linked source changed: ${id}`);
            }
            const owned = preservedSourceAudio(record, ref);
            if (owned) {
                approved.add(`${owned.sha256}:${owned.bytes}`);
            }
        }
        // A candidate the plan never saw (a legacy copy that appeared since) must carry the approved bytes, or a
        // fresh plan would call this source a conflict.
        const planned = new Set(entry.files.map((file) => file.path));
        for (const candidate of available) {
            if (candidate.sourceMeetingId !== entry.sourceMeetingId || planned.has(candidate.path)) {
                continue;
            }
            const stat = await lstat(candidate.path);
            if (!stat.isFile() || stat.size === 0) {
                continue;
            }

            if (!approved.has(`${await sha256FileAsync(candidate.path)}:${stat.size}`)) {
                throw new Error(`A conflicting source file appeared since the plan: ${candidate.path}`);
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
            // The plan's live answer and its hashes are minutes old by now: ask again before the copy, check the copy
            // against the approved digest, and ask once more before the copy is published.
            await refuseLive({ live, ...ref });
            const result = await preserveSourceAudio({
                store,
                meetingId: record.id,
                ref,
                sourcePath: file.path,
                expected: { sha256: file.sha256, bytes: file.bytes },
                beforePublish: () => refuseLive({ live, ...ref }),
            });
            results.push({ ...ref, recordId: record.id, status: result.status });
        }
    }
    return results;
}
