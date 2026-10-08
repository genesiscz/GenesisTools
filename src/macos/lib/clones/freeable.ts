import { lstatSync } from "node:fs";
import { join, relative } from "node:path";
import { walkFiles } from "@genesiscz/utils/fs/disk-usage";
import { logger } from "@genesiscz/utils/logger";
import { getCloneId, getPrivateSize } from "@genesiscz/utils/macos/apfs";
import { isUnderAny } from "./collapse";
import { clonesProfile } from "./profile";
import type { DuplicateSet } from "./render/types";

const log = logger.child({ component: "clones:freeable" });

/** What the kernel says about one file's blocks. A `null` means the probe
 *  failed (gone, not APFS); the holder then counts as freeing nothing. */
export interface BlockProbe {
    privateBytes(path: string): number | null;
    cloneId(path: string): bigint | null;
    allocatedBytes(path: string): number | null;
}

export const apfsProbe: BlockProbe = {
    privateBytes: getPrivateSize,
    cloneId: getCloneId,
    allocatedBytes(path) {
        try {
            return lstatSync(path).blocks * 512;
        } catch (err) {
            log.debug({ err, path }, "allocated-size probe failed");
            return null;
        }
    },
};

export interface FreeableArgs {
    set: DuplicateSet;
    /** Stores that stay keep-only: a holder under one is never rewritten. */
    fixedRoots: readonly string[];
    /** Every store root, rewritten or not. */
    storeRoots: readonly string[];
    probe?: BlockProbe;
}

/** One file position of a set: the keep file and every copy of it. */
interface Unit {
    keep: string;
    holders: string[];
}

function unitsOf(set: DuplicateSet): Unit[] {
    const all = [...new Set([...set.members, ...(set.storeMembers ?? [])])];
    if (set.kind === "file") {
        return [{ keep: set.keep, holders: all }];
    }

    const units: Unit[] = [];
    for (const e of walkFiles(set.keep, { onError: (err) => log.debug({ err }, "freeable walk error") })) {
        const rel = relative(set.keep, e.path);
        units.push({ keep: e.path, holders: all.map((m) => (m === set.keep ? e.path : join(m, rel))) });
    }

    return units;
}

/** Bytes the volume gains when apply rewrites this set.
 *
 *  A rewritten copy frees its private bytes and nothing else: a block it
 *  shares with anyone stays allocated. The one exception is a clone family
 *  (one APFS clone id) whose every holder is rewritten in the same set, so
 *  its shared blocks lose their last reference too. That is only proven when
 *  the family's origin is in view, which means a rewritten store file: a
 *  family of worktree files alone was cloned from a store file this scan did
 *  not see, and counting it is exactly the 3 GB that never came back. */
export function measureSetFreeable({ set, fixedRoots, storeRoots, probe = apfsProbe }: FreeableArgs): number {
    let freeable = 0;
    for (const unit of unitsOf(set)) {
        const writable = (h: string): boolean => h !== unit.keep && !isUnderAny(h, fixedRoots);
        const families = new Map<bigint, string[]>();
        for (const h of unit.holders) {
            if (writable(h)) {
                freeable += probe.privateBytes(h) ?? 0;
            }

            const id = probe.cloneId(h);
            if (id !== null && id !== 0n) {
                families.set(id, [...(families.get(id) ?? []), h]);
            }
        }

        for (const members of families.values()) {
            if (members.length < 2 || !members.every(writable) || !members.some((m) => isUnderAny(m, storeRoots))) {
                continue;
            }

            let shared = 0;
            for (const m of members) {
                const alloc = probe.allocatedBytes(m);
                const priv = probe.privateBytes(m);
                if (alloc !== null && priv !== null) {
                    shared = Math.max(shared, alloc - priv);
                }
            }

            freeable += shared;
        }
    }

    return freeable;
}

export interface AnnotateArgs {
    sets: DuplicateSet[];
    fixedRoots: readonly string[];
    storeRoots: readonly string[];
    /** Keep sets that free nothing (they are dropped by default, so apply does
     *  not rewrite files for no gain). */
    keepUnfreeable?: boolean;
    probe?: BlockProbe;
}

export interface AnnotatedSets {
    sets: DuplicateSet[];
    dropped: { sets: number; naiveBytes: number };
}

/** Measure every set, sort by freeable (largest first) and drop the sets that
 *  would free nothing. */
export function annotateFreeable({
    sets,
    fixedRoots,
    storeRoots,
    keepUnfreeable = false,
    probe,
}: AnnotateArgs): AnnotatedSets {
    return clonesProfile.measure("freeable", () => {
        const measured = sets.map((set) => ({
            ...set,
            freeable: measureSetFreeable({ set, fixedRoots, storeRoots, ...(probe !== undefined ? { probe } : {}) }),
        }));
        const kept = measured.filter((s) => keepUnfreeable || s.freeable > 0);
        const droppedSets = measured.filter((s) => !keepUnfreeable && s.freeable === 0);
        kept.sort((a, b) => b.freeable - a.freeable || b.reclaimable - a.reclaimable);
        const result = {
            sets: kept,
            dropped: { sets: droppedSets.length, naiveBytes: droppedSets.reduce((s, x) => s + x.reclaimable, 0) },
        };
        log.info(
            {
                sets: sets.length,
                kept: kept.length,
                dropped: result.dropped,
                freeable: kept.reduce((s, x) => s + x.freeable, 0),
            },
            "freeable measured"
        );
        return result;
    });
}
