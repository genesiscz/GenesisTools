import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { Storage } from "@app/utils/storage/storage";
import type { DuplicateSet } from "./render/types";

const storage = new Storage("macos-clones");
const TTL = "1 hour";

export interface PlanCacheParams {
    roots: string[];
    minSize: number;
    include: string[];
    exclude: string[];
    nodeModules: boolean;
}

export interface CachedPlan {
    plan: DuplicateSet[];
    ageMs: number;
}

/** Stable key: arrays sorted so equivalent invocations share a cache file. */
export function planCacheKey(p: PlanCacheParams): string {
    const normalized = {
        roots: [...p.roots].sort(),
        minSize: p.minSize,
        include: [...p.include].sort(),
        exclude: [...p.exclude].sort(),
        nodeModules: p.nodeModules,
    };
    const sha1 = createHash("sha1").update(SafeJSON.stringify(normalized)).digest("hex");
    return `plan-${sha1}.json`;
}

export async function cachePlan(p: PlanCacheParams, plan: DuplicateSet[]): Promise<void> {
    await storage.putCacheFile(planCacheKey(p), plan, TTL);
}

/** Returns the cached plan + its file age in ms, or null if absent/expired. */
export async function getCachedPlan(p: PlanCacheParams): Promise<CachedPlan | null> {
    const key = planCacheKey(p);
    const plan = await storage.getCacheFile<DuplicateSet[]>(key, TTL);
    if (plan === null) {
        return null;
    }

    const filePath = join(storage.getCacheDir(), key);
    const ageMs = existsSync(filePath) ? Date.now() - statSync(filePath).mtimeMs : 0;
    return { plan, ageMs };
}
