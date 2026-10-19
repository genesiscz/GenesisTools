import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { formatBytes } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { expandSetToPairs } from "./audit";
import { type ApplyPlanResult, applyReclaimPlan, type PlanRunResult, runReclaimPlan } from "./plan-runner";
import {
    listPresets,
    type Preset,
    type PresetAuto,
    selectorFromPreset,
    touchPreset,
    updatePresetAuto,
} from "./presets";
import { fixedStoreRoots, type ReclaimPlan, type ReclaimSelector } from "./reclaim";
import type { DuplicateSet } from "./render/types";

// Plans (presets) the daily scan task runs on its own. Only a preset marked `auto` runs, and every run is guarded:
// the first run after arming is a dry run that only reports, each later run first plans (a dry run), keeps only the
// duplicate sets that fit the preset's byte and file limits, and then clones those. The run log gets one report line
// per preset: what it would or did reclaim, why, and how much.

const log = logger.child({ component: "clones:auto-reclaim" });

/** A run's limits. An absent limit does not limit: an armed preset clones every set unless the user set one
 *  (Martin, 2026-10-19: the old 5 GB and 500-file defaults had no measured reason, and a set with more files than
 *  the cap was never cloned at all). */
export interface AutoLimits {
    maxBytes?: number;
    maxFiles?: number;
}

/** "no limits", "5 GB", "500 files" or "5 GB, 500 files". */
export function formatLimits(limits: AutoLimits): string {
    const parts = [
        ...(limits.maxBytes !== undefined ? [formatBytes(limits.maxBytes)] : []),
        ...(limits.maxFiles !== undefined ? [`${limits.maxFiles} files`] : []),
    ];
    return parts.length === 0 ? "no limits" : parts.join(", ");
}

/** The stored limits after a flag change: a number sets a limit, null clears it (`none`), undefined keeps it. */
export function mergeLimits(
    previous: AutoLimits | undefined,
    change: { maxBytes?: number | null; maxFiles?: number | null }
): AutoLimits {
    const maxBytes = change.maxBytes === null ? undefined : (change.maxBytes ?? previous?.maxBytes);
    const maxFiles = change.maxFiles === null ? undefined : (change.maxFiles ?? previous?.maxFiles);
    return {
        ...(maxBytes !== undefined ? { maxBytes } : {}),
        ...(maxFiles !== undefined ? { maxFiles } : {}),
    };
}

/** Files one set rewrites, counted from the same (keep, replace) pairs apply clones: a folder set counts every file
 *  under each replaced folder, and copies under a fixed store root stay as they are. */
function filesOf(set: DuplicateSet, keepOnlyRoots: readonly string[]): number {
    return expandSetToPairs(set, keepOnlyRoots).length;
}

export interface LimitedPlan {
    plan: ReclaimPlan;
    bytes: number;
    files: number;
    droppedSets: number;
    droppedBytes: number;
}

/** The plan cut to the limits: the biggest sets first, each kept only while the run's bytes and files still fit. */
export function limitPlan(plan: ReclaimPlan, limits: AutoLimits): LimitedPlan {
    const ordered = [...plan.sets].sort((a, b) => b.reclaimable - a.reclaimable);
    const keepOnlyRoots = fixedStoreRoots(plan);
    const kept: DuplicateSet[] = [];
    let bytes = 0;
    let files = 0;
    let droppedBytes = 0;

    for (const set of ordered) {
        const fitsBytes = limits.maxBytes === undefined || bytes + set.reclaimable <= limits.maxBytes;
        const setFiles = fitsBytes ? filesOf(set, keepOnlyRoots) : 0;

        if (fitsBytes && (limits.maxFiles === undefined || files + setFiles <= limits.maxFiles)) {
            kept.push(set);
            bytes += set.reclaimable;
            files += setFiles;
        } else {
            droppedBytes += set.reclaimable;
        }
    }

    return {
        plan: { ...plan, sets: kept, totalReclaimable: bytes },
        bytes,
        files,
        droppedSets: plan.sets.length - kept.length,
        droppedBytes,
    };
}

export type AutoReclaimAction = "dry-run" | "applied" | "nothing" | "failed";

export interface AutoReclaimOutcome {
    preset: string;
    action: AutoReclaimAction;
    /** Why this action, in words for the run log. */
    why: string;
    /** What the plan (the dry run) found. */
    planned: { sets: number; bytes: number };
    /** What fits the limits and would be, or was, cloned. */
    withinLimits: { sets: number; bytes: number; files: number };
    limits: AutoLimits;
    applied?: { cloned: number; skipped: number; errors: number; bytesReclaimed: number };
    runId?: string;
    error?: string;
}

export interface AutoReclaimDeps {
    presets: () => Preset[];
    plan: (selector: ReclaimSelector) => Promise<PlanRunResult>;
    apply: (plan: ReclaimPlan) => ApplyPlanResult;
    saveAuto: (id: string, auto: PresetAuto) => void;
    touch: (id: string, run: { lastRunAt: string; lastReclaimable: number }) => void;
    now: () => Date;
}

/**
 * Runs every preset marked auto, one after another. `dryRun` (the scan task's `--auto-dry-run`) plans and reports
 * but never clones, and does not count as a preset's first dry run. A preset that fails is reported and the next one
 * still runs.
 */
export async function runAutoReclaims({
    deps,
    dryRun = false,
}: {
    deps: AutoReclaimDeps;
    dryRun?: boolean;
}): Promise<AutoReclaimOutcome[]> {
    const marked = deps.presets().filter((preset): preset is AutoPreset => preset.auto?.enabled === true);
    const outcomes: AutoReclaimOutcome[] = [];

    for (const preset of marked) {
        outcomes.push(await runOne({ preset, deps, dryRun }));
    }

    return outcomes;
}

/**
 * Why the saved preset no longer authorizes this run, or null when its arming, limits and selector are unchanged. The
 * plan can scan for minutes, and a `presets auto --off`, a removal, new limits or a re-arm in that time must win over
 * the settings the run started with.
 */
function authorizationChange(armed: AutoPreset, saved: Preset[]): string | null {
    const current = saved.find((preset) => preset.id === armed.id);
    if (current === undefined) {
        return "the preset was removed while the plan ran";
    }

    const auto = current.auto;
    if (auto?.enabled !== true) {
        return "auto was turned off while the plan ran";
    }

    if (
        auto.maxBytes !== armed.auto.maxBytes ||
        auto.maxFiles !== armed.auto.maxFiles ||
        auto.dryRunAt !== armed.auto.dryRunAt
    ) {
        return "the preset's auto settings changed while the plan ran; the next run uses them";
    }

    if (SafeJSON.stringify(selectorFromPreset(current)) !== SafeJSON.stringify(selectorFromPreset(armed))) {
        return "the preset's folders or filters changed while the plan ran; the next run plans them";
    }

    return null;
}

type AutoPreset = Preset & { auto: PresetAuto };

async function runOne(input: {
    preset: AutoPreset;
    deps: AutoReclaimDeps;
    dryRun: boolean;
}): Promise<AutoReclaimOutcome> {
    const { preset, deps, dryRun } = input;
    const auto = preset.auto;
    const limits = mergeLimits(auto, {});
    const base = {
        preset: preset.id,
        limits,
        planned: { sets: 0, bytes: 0 },
        withinLimits: { sets: 0, bytes: 0, files: 0 },
    };

    try {
        const result = await deps.plan(selectorFromPreset(preset));

        if (result.status !== "ok") {
            const why = result.status === "aborted" ? "the plan was aborted" : result.error.message;
            return { ...base, action: "failed", why, error: why };
        }

        const plan = result.plan;
        const limited = limitPlan(plan, limits);
        const planned = { sets: plan.sets.length, bytes: plan.totalReclaimable };
        const withinLimits = { sets: limited.plan.sets.length, bytes: limited.bytes, files: limited.files };
        const outcome = { ...base, planned, withinLimits, runId: plan.runId };

        if (limited.plan.sets.length === 0) {
            const why =
                plan.sets.length === 0
                    ? "the plan found no duplicates"
                    : `no duplicate set fits the limits (${formatLimits(limits)})`;
            return { ...outcome, action: "nothing", why };
        }

        if (dryRun) {
            return { ...outcome, action: "dry-run", why: "the scan task ran with --auto-dry-run" };
        }

        const changed = authorizationChange(preset, deps.presets());
        if (changed !== null) {
            log.info({ preset: preset.id, why: changed }, "auto reclaim skipped: preset changed during the plan");
            return { ...outcome, action: "nothing", why: changed };
        }

        if (auto.dryRunAt === undefined) {
            deps.saveAuto(preset.id, { ...auto, dryRunAt: deps.now().toISOString() });
            return {
                ...outcome,
                action: "dry-run",
                why: "first run since auto was turned on: a dry run only; the next run clones",
            };
        }

        const applied = deps.apply(limited.plan);

        if (applied.status !== "ok") {
            return { ...outcome, action: "failed", why: applied.message, error: applied.message };
        }

        const totals = applied.report.totals;
        deps.touch(preset.id, { lastRunAt: deps.now().toISOString(), lastReclaimable: plan.totalFreeable });
        log.info({ preset: preset.id, totals, limits }, "auto reclaim applied");
        return {
            ...outcome,
            action: "applied",
            why: `marked auto; dry run done ${auto.dryRunAt}`,
            applied: {
                cloned: totals.cloned,
                skipped: totals.skipped,
                errors: totals.errors,
                bytesReclaimed: totals.bytesReclaimed,
            },
        };
    } catch (err) {
        log.error({ err, preset: preset.id }, "auto reclaim failed");
        const message = err instanceof Error ? err.message : String(err);
        return { ...base, action: "failed", why: message, error: message };
    }
}

/** The run-log lines of the auto reclaims. */
export function formatAutoReclaimReport(outcomes: AutoReclaimOutcome[]): string[] {
    if (outcomes.length === 0) {
        return [
            `auto reclaim: no plan is marked auto (${toolCommand("macos clones reclaim presets auto", "<id>", "--on")})`,
        ];
    }

    return [
        `auto reclaim: ${outcomes.length} plan${outcomes.length === 1 ? "" : "s"} marked auto`,
        ...outcomes.map((o) => {
            const found = `the plan found ${formatBytes(o.planned.bytes)} in ${o.planned.sets} sets; ${o.withinLimits.sets} sets, ${o.withinLimits.files} files, ${formatBytes(o.withinLimits.bytes)} fit the limits (${formatLimits(o.limits)})`;
            const run = o.runId ? ` · reclaim run log ${o.runId}` : "";

            switch (o.action) {
                case "applied":
                    return `  ${o.preset}: applied, ${o.applied?.cloned ?? 0} files cloned, ${formatBytes(o.applied?.bytesReclaimed ?? 0)} reclaimed, ${o.applied?.skipped ?? 0} skipped, ${o.applied?.errors ?? 0} errors (${found}; ${o.why})${run}`;
                case "dry-run":
                    return `  ${o.preset}: dry run, nothing cloned (${o.why}); ${found}${run}`;
                case "nothing":
                    return `  ${o.preset}: nothing to do, ${o.why}${run}`;
                default:
                    return `  ${o.preset}: failed, ${o.why}${run}`;
            }
        }),
    ];
}

/** The settings `presets auto <id> --on` stores: the given limits, else the old ones, else none. A new arming
 *  always starts without `dryRunAt`, so its first run is a dry run. */
export function armedAuto(
    previous: PresetAuto | undefined,
    change: { maxBytes?: number | null; maxFiles?: number | null }
): PresetAuto {
    return { enabled: true, ...mergeLimits(previous, change) };
}

export const realAutoReclaimDeps = (): AutoReclaimDeps => {
    return {
        presets: listPresets,
        plan: (selector) => runReclaimPlan({ selector, reuseSnapshot: false, registerDaemon: false }),
        apply: applyReclaimPlan,
        saveAuto: (id, auto) => {
            updatePresetAuto(id, auto);
        },
        touch: touchPreset,
        now: () => new Date(),
    };
};
