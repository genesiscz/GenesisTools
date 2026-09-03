import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";
import type { DuplicateSet } from "./render/types";

const log = logger.child({ component: "clones:plan-cache" });
const storage = new Storage("macos-clones");
const TTL = "1 hour";

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

export interface CachedPlan {
    plan: DuplicateSet[];
    ageMs: number;
    rootStamps: RootStamp[];
}

interface PlanCacheFile {
    plan: DuplicateSet[];
    rootStamps: RootStamp[];
}

/** Stable key: arrays sorted so equivalent invocations share a cache file. */
export function planCacheKey(p: PlanCacheParams): string {
    const normalized = {
        roots: [...p.roots].sort(),
        minSize: p.minSize,
        include: [...p.include].sort(),
        exclude: [...p.exclude].sort(),
        nodeModules: p.nodeModules,
        targets: [...p.targets].sort(),
        worktreesOf: p.worktreesOf,
        keepPartners: [...p.keepPartners].sort(),
    };
    const sha1 = createHash("sha1").update(SafeJSON.stringify(normalized)).digest("hex");
    return `plan-${sha1}.json`;
}

/** mtime of each root directory. A missing root stamps as -1 so it can never
 *  match a stored stamp. */
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

/** Every writer stamps the roots it scanned, with stamps taken BEFORE the
 *  scan: a plan without stamps can never be reused, so `optimize --apply`,
 *  `reclaim apply` and the daemon all read the same invalidation contract.
 *  The stamp is a cheap same-session shortcut, not the safety net: apply
 *  byte-verifies every pair in `dedupeFile` before it clones. */
export async function cachePlan(p: PlanCacheParams, plan: DuplicateSet[], rootStamps: RootStamp[]): Promise<void> {
    const file: PlanCacheFile = { plan, rootStamps };
    await storage.putCacheFile(planCacheKey(p), file, TTL);
}

/** Returns the cached plan + its file age in ms, or null if absent/expired.
 *  A file written before root stamps existed is a bare array; it reads back
 *  with no stamps, so `stampsMatch` rejects it. */
export async function getCachedPlan(p: PlanCacheParams): Promise<CachedPlan | null> {
    const key = planCacheKey(p);
    const stored = await storage.getCacheFile<PlanCacheFile | DuplicateSet[]>(key, TTL);
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
    return { plan: file.plan, ageMs, rootStamps: file.rootStamps ?? [] };
}
