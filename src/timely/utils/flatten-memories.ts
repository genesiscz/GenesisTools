import type { CreateEventInput, CreateEventTimestamp, TimelyEntry } from "@app/timely/types/api";

export interface FlatEntry {
    id: number;
    from: string;
    to: string;
}

export interface BuiltPayload {
    input: CreateEventInput;
    totalSeconds: number;
}

/** Merge intervals within a memory if the gap between them is at most this many seconds. */
const MERGE_GAP_TOLERANCE_SEC = 60;
/** Drop merged intervals shorter than this — too noisy to log. */
const MIN_BLOCK_SEC = 5 * 60;

/**
 * Walk memory buckets → app entries → sub-entries, returning a flat list of
 * (memoryId, from, to) triples sorted by `from`. Each item maps to one
 * `timestamps[]` entry on the Timely event payload.
 *
 * If `allowedIds` is provided, only entries whose memory id is in the set are
 * returned. Used by the plan/apply flow to filter to a specific event's IDs.
 */
export function flattenMemories(memories: TimelyEntry[], allowedIds?: Set<number>): FlatEntry[] {
    const raw: FlatEntry[] = [];

    const allowed = (id: number): boolean => !allowedIds || allowedIds.has(id);

    for (const bucket of memories) {
        const inner = bucket.entries ?? [];
        if (inner.length === 0) {
            if (bucket.id && bucket.from && bucket.to && allowed(bucket.id)) {
                raw.push({ id: bucket.id, from: bucket.from, to: bucket.to });
            }

            continue;
        }

        for (const entry of inner) {
            if (!allowed(entry.id)) {
                continue;
            }

            const subs = entry.sub_entries ?? [];
            if (subs.length === 0) {
                raw.push({ id: entry.id, from: entry.from, to: entry.to });
            } else {
                for (const sub of subs) {
                    raw.push({ id: entry.id, from: sub.from, to: sub.to });
                }
            }
        }
    }

    // Merge overlapping/touching intervals PER memory id to keep the visible
    // timestamps[] in the Timely UI minimal (otherwise dozens of 1-min rows).
    const byId = new Map<number, FlatEntry[]>();
    for (const f of raw) {
        const arr = byId.get(f.id) ?? [];
        arr.push(f);
        byId.set(f.id, arr);
    }

    const mergeToleranceMs = MERGE_GAP_TOLERANCE_SEC * 1000;
    const minBlockMs = MIN_BLOCK_SEC * 1000;

    const merged: FlatEntry[] = [];
    for (const [id, items] of byId) {
        const sorted = items
            .map((it) => ({
                id,
                fromMs: new Date(it.from).getTime(),
                toMs: new Date(it.to).getTime(),
                from: it.from,
                to: it.to,
            }))
            .filter((it) => it.toMs > it.fromMs)
            .sort((a, b) => a.fromMs - b.fromMs);

        if (sorted.length === 0) {
            continue;
        }

        const memoryMerged: { from: string; to: string; durationMs: number }[] = [];
        let curFrom = sorted[0].from;
        let curTo = sorted[0].to;
        let curFromMs = sorted[0].fromMs;
        let curToMs = sorted[0].toMs;
        for (let i = 1; i < sorted.length; i++) {
            const it = sorted[i];
            if (it.fromMs - curToMs <= mergeToleranceMs) {
                if (it.toMs > curToMs) {
                    curTo = it.to;
                    curToMs = it.toMs;
                }
            } else {
                memoryMerged.push({ from: curFrom, to: curTo, durationMs: curToMs - curFromMs });
                curFrom = it.from;
                curTo = it.to;
                curFromMs = it.fromMs;
                curToMs = it.toMs;
            }
        }

        memoryMerged.push({ from: curFrom, to: curTo, durationMs: curToMs - curFromMs });

        for (const block of memoryMerged) {
            if (block.durationMs >= minBlockMs) {
                merged.push({ id, from: block.from, to: block.to });
            }
        }
    }

    return merged.sort((a, b) => a.from.localeCompare(b.from));
}

/**
 * Compute wall-clock duration as the UNION of (possibly overlapping) intervals.
 * Memories from different apps frequently overlap (cmux + Cursor + Teams running
 * concurrently); summing them double-counts. The server expects merged duration.
 */
function unionDurationSeconds(flat: FlatEntry[]): number {
    if (flat.length === 0) {
        return 0;
    }

    const intervals = flat
        .map((f) => ({ from: new Date(f.from).getTime(), to: new Date(f.to).getTime() }))
        .filter((iv) => iv.to > iv.from)
        .sort((a, b) => a.from - b.from);

    if (intervals.length === 0) {
        return 0;
    }

    let totalMs = 0;
    let curFrom = intervals[0].from;
    let curTo = intervals[0].to;
    for (let i = 1; i < intervals.length; i++) {
        const iv = intervals[i];
        if (iv.from <= curTo) {
            if (iv.to > curTo) {
                curTo = iv.to;
            }
        } else {
            totalMs += curTo - curFrom;
            curFrom = iv.from;
            curTo = iv.to;
        }
    }

    totalMs += curTo - curFrom;
    return totalMs / 1000;
}

export function buildPayloadFromFlat(flat: FlatEntry[], day: string, projectId: number, note: string): BuiltPayload {
    if (flat.length === 0) {
        throw new Error(`No usable entries on ${day} — memories are empty or filtered out`);
    }

    const timestamps: CreateEventTimestamp[] = flat.map((f) => ({
        from: f.from,
        to: f.to,
        entry_ids: [`tool_tic_${f.id}`],
    }));

    const totalSec = unionDurationSeconds(flat);
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = Math.floor(totalSec % 60);

    const minFrom = flat.reduce((min, f) => (f.from < min ? f.from : min), flat[0].from);
    const maxTo = flat.reduce((max, f) => (f.to > max ? f.to : max), flat[0].to);

    return {
        input: {
            day,
            project_id: projectId,
            note,
            from: minFrom,
            to: maxTo,
            hours,
            minutes,
            seconds,
            timestamps,
            created_from: "GenesisTools",
            updated_from: "GenesisTools",
        },
        totalSeconds: totalSec,
    };
}
