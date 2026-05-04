import type { IndexedLogEntry } from "@app/debugging-master/types";

export interface SnapshotDelta {
    added: Array<{ key: string; value: unknown }>;
    removed: Array<{ key: string; value: unknown }>;
    changed: Array<{ key: string; from: unknown; to: unknown }>;
    sameCount: number;
}

/**
 * Find the most recent prior `snapshot` entry with a matching `label`
 * (chronologically before `atIndex`). Returns null if none exists.
 */
export function findPreviousSnapshot(
    entries: IndexedLogEntry[],
    label: string,
    atIndex: number
): IndexedLogEntry | null {
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.index >= atIndex) {
            continue;
        }
        if (e.level === "snapshot" && e.label === label && e.vars) {
            return e;
        }
    }
    return null;
}

/**
 * Compute a shallow per-key delta between two `vars` records. Nested values
 * are compared with structural equality so unchanged sub-trees count as `same`.
 */
export function diffVars(prev: Record<string, unknown>, next: Record<string, unknown>): SnapshotDelta {
    const added: SnapshotDelta["added"] = [];
    const removed: SnapshotDelta["removed"] = [];
    const changed: SnapshotDelta["changed"] = [];
    let sameCount = 0;

    const keys = new Set<string>([...Object.keys(prev), ...Object.keys(next)]);
    for (const key of keys) {
        const inPrev = Object.hasOwn(prev, key);
        const inNext = Object.hasOwn(next, key);
        if (inPrev && !inNext) {
            removed.push({ key, value: prev[key] });
            continue;
        }
        if (!inPrev && inNext) {
            added.push({ key, value: next[key] });
            continue;
        }
        if (deepEqual(prev[key], next[key])) {
            sameCount++;
        } else {
            changed.push({ key, from: prev[key], to: next[key] });
        }
    }
    return { added, removed, changed, sameCount };
}

function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) {
        return true;
    }
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
        return false;
    }
    if (Array.isArray(a) !== Array.isArray(b)) {
        return false;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) {
            return false;
        }
        for (let i = 0; i < a.length; i++) {
            if (!deepEqual(a[i], b[i])) {
                return false;
            }
        }
        return true;
    }
    const aRec = a as Record<string, unknown>;
    const bRec = b as Record<string, unknown>;
    const aKeys = Object.keys(aRec);
    const bKeys = Object.keys(bRec);
    if (aKeys.length !== bKeys.length) {
        return false;
    }
    for (const k of aKeys) {
        if (!Object.hasOwn(bRec, k) || !deepEqual(aRec[k], bRec[k])) {
            return false;
        }
    }
    return true;
}
