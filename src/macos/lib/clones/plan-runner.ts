import type { WalkProgress } from "@genesiscz/utils/fs/disk-usage";
import { logger } from "@genesiscz/utils/logger";
import { CloneUnsupportedError } from "@genesiscz/utils/macos/apfs";
import { IntegrityError, runOptimize } from "./audit";
import {
    cachePlan,
    getCachedPlan,
    membersMatch,
    type PlanCacheParams,
    planCacheParams,
    stampRoots,
    stampsMatch,
} from "./cache";
import { ensureClonesDaemonTasks } from "./daemon-tasks";
import { RepoNotFoundError } from "./discover";
import { FileMetaCache } from "./file-meta-cache";
import { clonesProfile } from "./profile";
import { planReclaim, type ReclaimPhase, type ReclaimPlan, type ReclaimSelector } from "./reclaim";
import { appendReclaimEvent } from "./reclaim-run";
import type { DuplicateSet, ProcessReport } from "./render/types";
import { loadClonesConfig } from "./store";

const log = logger.child({ component: "clones:plan-runner" });

/** The 60-second snapshot is keyed the same way from every door: `planCacheKey`
 *  normalises an empty `targets` to the `gitignored` default, so a `reclaim`
 *  plan and a plain `optimize --apply` over the same roots share one file. */
export function planCacheParamsFor(selector: ReclaimSelector, roots: string[]): PlanCacheParams {
    return planCacheParams({
        roots,
        minSize: selector.minReal,
        exclude: selector.exclude,
        targets: selector.targets,
        ...(selector.worktreesOf !== undefined ? { worktreesOf: selector.worktreesOf } : {}),
        keepPartners: selector.keepPartners,
    });
}

/** Reuse the snapshot only while every discovered root still has the mtime it
 *  had, AND every path the plan names still has the size and mtime it had. The
 *  root mtimes alone move only on a direct-child namespace change, so a
 *  rebuild that rewrites `node_modules/<pkg>/dist/index.js` in place left the
 *  snapshot looking fresh and the apply reported a big plan with near-zero
 *  reclaimed bytes.
 *
 *  ⚠️ Both checks look only at what the plan already names, so a reused
 *  snapshot is fresh but never provably complete: a duplicate created since
 *  the plan was written is in no stamp and stays out of the sets. That is why
 *  `PLAN_SNAPSHOT_TTL` is 60 seconds, why the reuse says so in the log, and
 *  why the plan output says so to the user. */
export function snapshotHook(selector: ReclaimSelector): (roots: string[]) => Promise<DuplicateSet[] | null> {
    return async (roots) => {
        const params = planCacheParamsFor(selector, roots);
        const cached = await getCachedPlan(params);
        if (cached === null) {
            log.info({ roots: roots.length }, "plan snapshot absent — scanning");
            return null;
        }

        if (!stampsMatch(cached.rootStamps, stampRoots(roots))) {
            log.info({ roots: roots.length, ageMs: cached.ageMs }, "plan snapshot stale — scanning");
            return null;
        }

        if (!membersMatch(cached.memberStamps)) {
            log.info({ roots: roots.length, ageMs: cached.ageMs }, "plan snapshot members changed — scanning");
            return null;
        }

        log.info(
            { roots: roots.length, ageMs: cached.ageMs, sets: cached.plan.length, complete: false },
            "plan snapshot reused — nothing it names has changed, but duplicates created since it was written are not in it"
        );
        return cached.plan;
    };
}

export async function savePlanSnapshot(selector: ReclaimSelector, plan: ReclaimPlan): Promise<void> {
    await cachePlan(planCacheParamsFor(selector, plan.roots), plan.sets, plan.rootStamps);
}

/** A finished plan registers the daily scan and cache reconciliation with
 *  `tools daemon`, once: an existing registration is never overwritten (that
 *  is `daemon enable`), and a persisted `daemon: false` (what `daemon disable`
 *  writes) stops it entirely. A failure here is logged and never fails the
 *  plan. Returns a line to show when something was written. */
export async function registerDaemonAfterPlan(): Promise<string | null> {
    const cfg = await loadClonesConfig();
    if (cfg.daemon === false) {
        log.debug("daemon registration skipped — disabled in the clones config");
        return null;
    }

    try {
        const done = await ensureClonesDaemonTasks({ overwrite: false });
        if (done.scan || done.prune) {
            return "daemon tasks: scan daily at 03:00, cache reconciliation at 04:00 (tools macos clones daemon status)";
        }
    } catch (err) {
        log.warn({ err }, "daemon registration after plan failed");
    }

    return null;
}

export interface PlanRunHooks {
    /** One call per FINISHED stage. */
    onPhase?: (phase: ReclaimPhase, detail: string) => void;
    onDirEntered?: (dir: string) => void;
    onWalkProgress?: (p: WalkProgress) => void;
    /** Something durable was written (a snapshot, a daemon registration). */
    onRecorded?: (text: string) => void;
    onFailed?: () => void;
}

export interface PlanRunArgs {
    selector: ReclaimSelector;
    /** Reuse a fresh 60-second snapshot instead of scanning. */
    reuseSnapshot: boolean;
    /** `--no-daemon` sets this false; the persisted opt-out is checked too. */
    registerDaemon: boolean;
    hooks?: PlanRunHooks;
}

export type PlanRunResult =
    | { status: "ok"; plan: ReclaimPlan }
    | { status: "aborted" }
    | { status: "repo-not-found"; error: RepoNotFoundError };

/** Discover, scan and collapse under one file-meta cache lifetime, with SIGINT
 *  wired to the scan. The cache is flushed and pruned in a `finally`: without
 *  it a Ctrl+C after minutes of hashing dropped every dirty sha256 row and the
 *  next run re-hashed from scratch. */
export async function runReclaimPlan(args: PlanRunArgs): Promise<PlanRunResult> {
    const controller = new AbortController();
    const onSigint = (): void => {
        if (!controller.signal.aborted) {
            log.warn("SIGINT received, aborting reclaim");
            controller.abort(new Error("aborted by SIGINT"));
        }
    };
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigint);

    const hooks = args.hooks ?? {};
    const cache = FileMetaCache.getInstance();
    const scanStartedAt = Date.now();
    let scopedRoots: string[] = [];
    try {
        const plan = await planReclaim(args.selector, {
            signal: controller.signal,
            // File rows only. The native walk never consults the dir cache, and
            // loading it is what a 1.4M-row dir_meta table costs: 67 s of a 120 s
            // fleet plan before this view existed. Leaving getDir/setDir off the
            // view also keeps the in-process fallback from writing new dir rows.
            cache: { get: (path) => cache.get(path), set: (path, entry) => cache.set(path, entry) },
            ...(hooks.onDirEntered !== undefined ? { onDirEntered: hooks.onDirEntered } : {}),
            ...(hooks.onWalkProgress !== undefined ? { onWalkProgress: hooks.onWalkProgress } : {}),
            ...(hooks.onPhase !== undefined ? { onPhase: hooks.onPhase } : {}),
            ...(args.reuseSnapshot ? { snapshot: snapshotHook(args.selector) } : {}),
            // Keep-partner stores hold the injected candidates, and
            // FileMetaCache.get has no DB fallback, so a scope that is not
            // loaded is a guaranteed miss and a re-hash on every warm run.
            onDiscovered: async (roots, keepRoots) => {
                scopedRoots = [...new Set([...roots, ...keepRoots])];
                for (const root of scopedRoots) {
                    await cache.loadScope(root);
                }
            },
        });

        clonesProfile.summary("reclaim");
        if (args.registerDaemon) {
            const recorded = await registerDaemonAfterPlan();
            if (recorded !== null) {
                hooks.onRecorded?.(recorded);
            }
        }

        return { status: "ok", plan };
    } catch (err) {
        hooks.onFailed?.();
        if (controller.signal.aborted) {
            log.warn({ err }, "reclaim aborted");
            return { status: "aborted" };
        }

        if (err instanceof RepoNotFoundError) {
            return { status: "repo-not-found", error: err };
        }

        throw err;
    } finally {
        // Flush + prune regardless of the exit path: an aborted or failed run
        // wrote sha256 rows too, and close() drops every dirty one.
        try {
            await cache.flush(scanStartedAt);
            // Only scopes this run actually walked: pruning by `scanStartedAt`
            // after a snapshot reuse would drop every row the run never touched.
            for (const root of scopedRoots) {
                await cache.pruneScope(root, scanStartedAt);
            }
        } finally {
            cache.close();
        }

        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigint);
    }
}

export type ApplyPlanResult =
    | { status: "ok"; report: ProcessReport }
    | { status: "clone-unsupported"; message: string }
    | { status: "integrity"; message: string };

/** Clone the plan's pairs and record the outcome in the run log. An integrity
 *  abort gets its own status so the CLI can print the `INTEGRITY ABORT:` label
 *  `optimize` already prints, and so the run log ends on `phase: error`
 *  instead of looking byte-identical to a declined run. */
export function applyReclaimPlan(plan: ReclaimPlan): ApplyPlanResult {
    try {
        const report = runOptimize({
            roots: plan.roots,
            sets: plan.sets,
            planCacheHit: plan.fromSnapshot,
            keepOnlyRoots: plan.keepRoots.map((k) => k.root),
            cache: FileMetaCache.getInstance(),
        });
        appendReclaimEvent(plan.runId, {
            phase: "apply",
            processId: report.id,
            cloned: report.totals.cloned,
            skipped: report.totals.skipped,
            errors: report.totals.errors,
            bytesReclaimed: report.totals.bytesReclaimed,
        });
        clonesProfile.summary("reclaim apply");
        return { status: "ok", report };
    } catch (err) {
        if (err instanceof IntegrityError) {
            appendReclaimEvent(plan.runId, { phase: "error", message: err.message });
            return { status: "integrity", message: err.message };
        }

        if (err instanceof CloneUnsupportedError) {
            appendReclaimEvent(plan.runId, { phase: "error", message: err.message });
            return { status: "clone-unsupported", message: err.message };
        }

        throw err;
    }
}
