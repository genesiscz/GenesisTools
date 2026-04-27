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

/**
 * Walk memory buckets → app entries → sub-entries, returning a flat list of
 * (memoryId, from, to) triples sorted by `from`. Each item maps to one
 * `timestamps[]` entry on the Timely event payload.
 *
 * If `allowedIds` is provided, only entries whose memory id is in the set are
 * returned. Used by the plan/apply flow to filter to a specific event's IDs.
 */
export function flattenMemories(memories: TimelyEntry[], allowedIds?: Set<number>): FlatEntry[] {
    const flat: FlatEntry[] = [];

    const allowed = (id: number): boolean => !allowedIds || allowedIds.has(id);

    for (const bucket of memories) {
        const inner = bucket.entries ?? [];
        if (inner.length === 0) {
            if (bucket.id && bucket.from && bucket.to && allowed(bucket.id)) {
                flat.push({ id: bucket.id, from: bucket.from, to: bucket.to });
            }

            continue;
        }

        for (const entry of inner) {
            if (!allowed(entry.id)) {
                continue;
            }

            const subs = entry.sub_entries ?? [];
            if (subs.length === 0) {
                flat.push({ id: entry.id, from: entry.from, to: entry.to });
            } else {
                for (const sub of subs) {
                    flat.push({ id: entry.id, from: sub.from, to: sub.to });
                }
            }
        }
    }

    return flat.sort((a, b) => a.from.localeCompare(b.from));
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

    return {
        input: {
            day,
            project_id: projectId,
            note,
            from: flat[0].from,
            to: flat[flat.length - 1].to,
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
