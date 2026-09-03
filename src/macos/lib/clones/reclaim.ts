import type { FileMetaCacheLike } from "@genesiscz/utils/fs/disk-usage";
import { logger } from "@genesiscz/utils/logger";
import { collapseDuplicates } from "./collapse";
import { discoverRoots } from "./discover";
import {
    type KeepPartnerId,
    makePartnerFor,
    type ResolvedKeepPartner,
    resolveKeepPartners,
    spawnCacheCommand,
} from "./keep-partners";
import { clonesProfile } from "./profile";
import { appendReclaimEvent, newReclaimRunId } from "./reclaim-run";
import type { DuplicateSet } from "./render/types";
import type { SkippedRoot } from "./targets";

const log = logger.child({ component: "clones:reclaim" });

/** Same floor as `optimize --min-real`: below 10 MB the syscalls cost more
 *  than the reclaim is worth on an install tree. */
export const DEFAULT_MIN_REAL = 10485760;

export interface ReclaimSelector {
    dirs: string[];
    worktreesOf?: string;
    targets: string[];
    exclude: string[];
    minReal: number;
    keepPartners: KeepPartnerId[];
}

export interface ReclaimPlan {
    runId: string;
    selector: ReclaimSelector;
    roots: string[];
    skipped: SkippedRoot[];
    keepRoots: ResolvedKeepPartner[];
    sets: DuplicateSet[];
    totalReclaimable: number;
    /** True when the sets came from a fresh plan snapshot instead of a scan. */
    fromSnapshot: boolean;
}

export type ReclaimPhase = "discover" | "collapse" | "snapshot";

export interface PlanReclaimOpts {
    signal?: AbortSignal;
    onDirEntered?: (dir: string) => void;
    onPhase?: (phase: ReclaimPhase, detail: string) => void;
    cache?: FileMetaCacheLike;
    /** Called with the discovered roots. Returning sets skips the collapse
     *  (an apply that follows a fresh plan). Null means scan. */
    snapshot?: (roots: string[]) => Promise<DuplicateSet[] | null> | DuplicateSet[] | null;
}

export function defaultSelector(dirs: string[]): ReclaimSelector {
    return { dirs, targets: ["gitignored"], exclude: [], minReal: DEFAULT_MIN_REAL, keepPartners: [] };
}

function sumReclaimable(sets: DuplicateSet[]): number {
    return sets.reduce((s, x) => s + x.reclaimable, 0);
}

/** Discover → resolve keep partners → collapse. Mutates nothing on disk except
 *  the run log. `keepPartners` is empty by default, so a package-manager store
 *  joins a duplicate set only when the user asked for it. Every phase is timed
 *  under the `clones` profiler scope. */
export async function planReclaim(selector: ReclaimSelector, opts: PlanReclaimOpts = {}): Promise<ReclaimPlan> {
    const endPlan = clonesProfile.start("plan");
    const runId = newReclaimRunId();
    appendReclaimEvent(runId, {
        phase: "start",
        dirs: selector.dirs,
        worktreesOf: selector.worktreesOf ?? null,
        targets: selector.targets,
        keepPartners: selector.keepPartners,
        minReal: selector.minReal,
    });

    const discovered = await discoverRoots({
        dirs: selector.dirs,
        targets: selector.targets,
        ...(selector.worktreesOf !== undefined ? { worktreesOf: selector.worktreesOf } : {}),
    });
    appendReclaimEvent(runId, {
        phase: "discover",
        roots: discovered.roots.length,
        skipped: discovered.skipped,
    });
    opts.onPhase?.("discover", `${discovered.roots.length} root(s), ${discovered.skipped.length} skipped`);

    const keepRoots = resolveKeepPartners(selector.keepPartners, spawnCacheCommand);
    const keepOnlyRoots = keepRoots.map((k) => k.root);

    const finish = (sets: DuplicateSet[], fromSnapshot: boolean): ReclaimPlan => {
        const totalReclaimable = sumReclaimable(sets);
        appendReclaimEvent(runId, { phase: "plan", sets: sets.length, totalReclaimable, fromSnapshot });
        const elapsedMs = Math.round(endPlan());
        log.info(
            {
                runId,
                roots: discovered.roots.length,
                skipped: discovered.skipped.length,
                keepRoots: keepRoots.map((k) => k.id),
                sets: sets.length,
                totalReclaimable,
                fromSnapshot,
                elapsedMs,
            },
            "reclaim plan complete"
        );
        return {
            runId,
            selector,
            roots: discovered.roots,
            skipped: discovered.skipped,
            keepRoots,
            sets,
            totalReclaimable,
            fromSnapshot,
        };
    };

    if (discovered.roots.length === 0) {
        log.warn({ runId, dirs: selector.dirs }, "reclaim plan found no roots");
        return finish([], false);
    }

    const lookup = opts.snapshot;
    const snapshot =
        lookup === undefined
            ? null
            : await clonesProfile.measureAsync("snapshot", async () => (await lookup(discovered.roots)) ?? null);
    if (snapshot !== null) {
        opts.onPhase?.("snapshot", `${snapshot.length} set(s) reused`);
        return finish(snapshot, true);
    }

    opts.onPhase?.("collapse", `${discovered.roots.length} root(s)`);
    const report = await clonesProfile.measureAsync("collapse", () =>
        collapseDuplicates({
            roots: discovered.roots,
            minSize: selector.minReal,
            exclude: selector.exclude,
            keepOnlyRoots,
            ...(keepOnlyRoots.length > 0 ? { partnerFor: makePartnerFor(keepRoots) } : {}),
            ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
            ...(opts.onDirEntered !== undefined ? { onDirEntered: opts.onDirEntered } : {}),
            ...(opts.cache !== undefined ? { cache: opts.cache } : {}),
        })
    );
    appendReclaimEvent(runId, { phase: "collapse", sets: report.sets.length, stats: report.stats ?? null });
    return finish(report.sets, false);
}
