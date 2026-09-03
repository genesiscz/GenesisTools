import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";
import type { DuplicateSet } from "./render/types";

const log = logger.child({ component: "clones:plan-cache" });
const storage = new Storage("macos-clones");

/** How long a written snapshot may be reused, and deliberately short.
 *
 *  The stamps prove that nothing the plan NAMES has changed. They cannot prove
 *  the plan is still COMPLETE: a file that became a duplicate after the plan
 *  was written appears in no stamp, so `stampsMatch` and `membersMatch` both
 *  pass while the reused sets miss it. Reuse therefore means "still valid",
 *  never "still current".
 *
 *  60 seconds covers the `plan` → `apply` hand-off a person types in one go,
 *  which is the only reuse worth having. The old hour sold an hour-old plan as
 *  a current one, and an `apply` is a rescan the user already waited through
 *  once (about 51 s for the whole fleet). */
export const PLAN_SNAPSHOT_TTL = "60 seconds";

export interface PlanCacheParams {
    roots: string[];
    minSize: number;
    include: string[];
    exclude: string[];
    nodeModules: boolean;
    targets: string[];
    worktreesOf: string;
    keepPartners: string[];
}

export interface RootStamp {
    path: string;
    mtimeMs: number;
}

export interface MemberStamp {
    path: string;
    size: number;
    /** APFS nanosecond mtime. Past 2^53, so it travels as a string. */
    mtimeNs: string;
}

export interface CachedPlan {
    plan: DuplicateSet[];
    ageMs: number;
    rootStamps: RootStamp[];
    memberStamps: MemberStamp[];
}

interface PlanCacheFile {
    plan: DuplicateSet[];
    rootStamps: RootStamp[];
    memberStamps?: MemberStamp[];
}

/** What `--targets` means when a caller passes none. `optimize` and the scan
 *  daemon key an empty list while `reclaim` keys the spelled-out default, and
 *  an unnormalised key made the two doors rescan each other's snapshots. */
const DEFAULT_TARGETS = ["gitignored"];

/** Every PlanCacheParams comes from here, so a new field cannot be added to
 *  one caller and silently forgotten in the other three. */
export function planCacheParams(p: {
    roots: string[];
    minSize: number;
    include?: string[];
    exclude?: string[];
    nodeModules?: boolean;
    targets?: string[];
    worktreesOf?: string;
    keepPartners?: string[];
}): PlanCacheParams {
    return {
        roots: p.roots,
        minSize: p.minSize,
        include: p.include ?? [],
        exclude: p.exclude ?? [],
        nodeModules: p.nodeModules ?? false,
        targets: p.targets ?? [],
        worktreesOf: p.worktreesOf ?? "",
        keepPartners: p.keepPartners ?? [],
    };
}

/** Stable key: arrays sorted so equivalent invocations share a cache file. */
export function planCacheKey(p: PlanCacheParams): string {
    const normalized = {
        roots: [...p.roots].sort(),
        minSize: p.minSize,
        include: [...p.include].sort(),
        exclude: [...p.exclude].sort(),
        nodeModules: p.nodeModules,
        targets: (p.targets.length === 0 ? DEFAULT_TARGETS : p.targets).slice().sort(),
        worktreesOf: p.worktreesOf,
        keepPartners: [...p.keepPartners].sort(),
    };
    const sha1 = createHash("sha1").update(SafeJSON.stringify(normalized)).digest("hex");
    return `plan-${sha1}.json`;
}

/** mtime of each root directory. A missing root stamps as -1 so it can never
 *  match a stored stamp. This alone is NOT enough: a directory's mtime moves
 *  only on a direct-child namespace change, so a rebuild that rewrites files
 *  in place leaves it untouched. `stampMembers` covers that. */
export function stampRoots(roots: string[]): RootStamp[] {
    return roots.map((path) => {
        try {
            return { path, mtimeMs: statSync(path).mtimeMs };
        } catch (err) {
            log.debug({ err, path }, "stampRoots: stat failed");
            return { path, mtimeMs: -1 };
        }
    });
}

/** True only when both lists name the same roots with the same mtimes. An
 *  empty list never matches: a snapshot without stamps is not trusted. */
export function stampsMatch(a: RootStamp[], b: RootStamp[]): boolean {
    if (a.length !== b.length || a.length === 0) {
        return false;
    }

    const byPath = new Map(a.map((s) => [s.path, s.mtimeMs]));
    return b.every((s) => s.mtimeMs >= 0 && byPath.get(s.path) === s.mtimeMs);
}

/** (size, mtimeNs) of every path the plan names, taken when the plan is
 *  written. Members only — no tree walk — so the cost is one statSync per
 *  member of every set. */
export function stampMembers(sets: DuplicateSet[]): MemberStamp[] {
    const out: MemberStamp[] = [];
    const seen = new Set<string>();
    for (const set of sets) {
        for (const member of set.members) {
            if (seen.has(member)) {
                continue;
            }

            seen.add(member);
            try {
                const st = statSync(member, { bigint: true });
                out.push({ path: member, size: Number(st.size), mtimeNs: st.mtimeNs.toString() });
            } catch (err) {
                log.debug({ err, path: member }, "stampMembers: stat failed");
                out.push({ path: member, size: -1, mtimeNs: "-1" });
            }
        }
    }

    return out;
}

/** True when every stamped member still has the size and mtime it had when the
 *  plan was written. A member that is gone, or that a rebuild rewrote, makes
 *  the snapshot stale — which the root mtimes alone never noticed.
 *
 *  ⚠️ This re-stats only the paths the plan NAMES, so it detects staleness and
 *  never incompleteness. A file rewritten to match another one, or a new file
 *  under a nested directory, is in no stamp: this returns true and the reused
 *  sets simply do not contain it. `PLAN_SNAPSHOT_TTL` bounds how long that can
 *  matter; nothing here closes it. */
export function membersMatch(stamps: MemberStamp[]): boolean {
    for (const stamp of stamps) {
        try {
            const st = statSync(stamp.path, { bigint: true });
            if (Number(st.size) !== stamp.size || st.mtimeNs.toString() !== stamp.mtimeNs) {
                log.debug({ path: stamp.path }, "plan snapshot member changed");
                return false;
            }
        } catch (err) {
            log.debug({ err, path: stamp.path }, "plan snapshot member is gone");
            return false;
        }
    }

    return true;
}

/** Every writer stamps the roots it scanned, with stamps taken BEFORE the
 *  scan, plus the members the plan names: a plan without stamps can never be
 *  reused, so `optimize --apply`, `reclaim apply` and the daemon all read the
 *  same invalidation contract. The stamps are a cheap freshness check, not a
 *  completeness proof and not the safety net: they say only that what the plan
 *  names is unchanged, and apply byte-verifies every pair in `dedupeFile`
 *  before it clones. */
export async function cachePlan(p: PlanCacheParams, plan: DuplicateSet[], rootStamps: RootStamp[]): Promise<void> {
    const file: PlanCacheFile = { plan, rootStamps, memberStamps: stampMembers(plan) };
    await storage.putCacheFile(planCacheKey(p), file, PLAN_SNAPSHOT_TTL);
}

/** Returns the cached plan + its file age in ms, or null if absent/expired.
 *  A file written before root stamps existed is a bare array; it reads back
 *  with no stamps, so `stampsMatch` rejects it. */
export async function getCachedPlan(p: PlanCacheParams): Promise<CachedPlan | null> {
    const key = planCacheKey(p);
    const stored = await storage.getCacheFile<PlanCacheFile | DuplicateSet[]>(key, PLAN_SNAPSHOT_TTL);
    if (stored === null) {
        return null;
    }

    const file: PlanCacheFile = Array.isArray(stored) ? { plan: stored, rootStamps: [] } : stored;
    const filePath = join(storage.getCacheDir(), key);
    // Single statSync (no existsSync prelude) to avoid the TOCTOU window where
    // the file is removed between existsSync and statSync. On ENOENT we treat
    // the plan as fresh (ageMs=0) since storage.getCacheFile already validated it.
    let rawAge = 0;
    try {
        rawAge = Date.now() - statSync(filePath).mtimeMs;
    } catch (err) {
        log.debug({ err, filePath }, "plan cache stat failed after read");
        rawAge = 0;
    }

    const ageMs = Math.max(0, rawAge);
    return { plan: file.plan, ageMs, rootStamps: file.rootStamps ?? [], memberStamps: file.memberStamps ?? [] };
}
