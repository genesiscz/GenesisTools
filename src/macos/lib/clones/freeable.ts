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

/** What rewriting one set gives back. */
export interface SetFreeable {
    /** Private bytes of the rewritten copies: freed whatever else exists on the volume. */
    proven: number;
    /** `proven` plus the shared blocks of clone families that are wholly rewritten and hold a store
     *  file. Those blocks come back only if no tree OUTSIDE the scan clones the same store file, and
     *  the bun cache is shared by every project, so this is an upper bound, never a promise. */
    upTo: number;
    /** False when no rewritten copy could be probed (not APFS, not macOS): nothing is known. */
    measured: boolean;
}

/** Bytes the volume gains when apply rewrites this set.
 *
 *  A rewritten copy frees its private bytes and nothing else: a block it shares with anyone stays
 *  allocated. A clone family (one APFS clone id) whose every holder in view is rewritten can free its
 *  shared blocks too, but only when no clone outside the scan still holds them, which this cannot
 *  see. That part is reported as `upTo`. A family of worktree files alone (origin a store file the
 *  scan did not see) adds nothing even there: counting it is the 3 GB that never came back. */
export function measureSetFreeable({ set, fixedRoots, storeRoots, probe = apfsProbe }: FreeableArgs): SetFreeable {
    let proven = 0;
    let shared = 0;
    let measured = false;
    for (const unit of unitsOf(set)) {
        const writable = (h: string): boolean => h !== unit.keep && !isUnderAny(h, fixedRoots);
        const families = new Map<bigint, string[]>();
        for (const h of unit.holders) {
            if (writable(h)) {
                const privateBytes = probe.privateBytes(h);
                if (privateBytes !== null) {
                    measured = true;
                    proven += privateBytes;
                }
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

            let familyShared = 0;
            for (const m of members) {
                const alloc = probe.allocatedBytes(m);
                const priv = probe.privateBytes(m);
                if (alloc !== null && priv !== null) {
                    familyShared = Math.max(familyShared, alloc - priv);
                }
            }

            shared += familyShared;
        }
    }

    return { proven, upTo: proven + shared, measured };
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
        const annotated = sets.map((set) => {
            const m = measureSetFreeable({ set, fixedRoots, storeRoots, ...(probe !== undefined ? { probe } : {}) });

            // Off APFS nothing is known, so nothing is dropped and no number is shown.
            return m.measured ? { ...set, freeable: m.proven, freeableUpTo: m.upTo } : { ...set };
        });
        const frees = (s: DuplicateSet): boolean => s.freeable === undefined || (s.freeableUpTo ?? 0) > 0;
        const kept = annotated.filter((s) => keepUnfreeable || frees(s));
        const droppedSets = annotated.filter((s) => !keepUnfreeable && !frees(s));
        kept.sort(
            (a, b) =>
                (b.freeable ?? -1) - (a.freeable ?? -1) ||
                (b.freeableUpTo ?? -1) - (a.freeableUpTo ?? -1) ||
                b.reclaimable - a.reclaimable
        );
        const result = {
            sets: kept,
            dropped: { sets: droppedSets.length, naiveBytes: droppedSets.reduce((s, x) => s + x.reclaimable, 0) },
        };
        log.info(
            {
                sets: sets.length,
                kept: kept.length,
                unmeasured: annotated.filter((s) => s.freeable === undefined).length,
                dropped: result.dropped,
                freeable: kept.reduce((s, x) => s + (x.freeable ?? 0), 0),
                freeableUpTo: kept.reduce((s, x) => s + (x.freeableUpTo ?? 0), 0),
            },
            "freeable measured"
        );
        return result;
    });
}
