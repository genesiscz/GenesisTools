import { formatBytes } from "@genesiscz/utils/format";
import { logger } from "@genesiscz/utils/logger";
import { type ApplyPlanResult, applyReclaimPlan, type PlanRunResult, runReclaimPlan } from "./plan-runner";
import {
    listPresets,
    type Preset,
    type PresetAuto,
    selectorFromPreset,
    touchPreset,
    updatePresetAuto,
} from "./presets";
import type { ReclaimPlan, ReclaimSelector } from "./reclaim";
import type { DuplicateSet } from "./render/types";

// Plans (presets) the daily scan task runs on its own. Only a preset marked `auto` runs, and every run is guarded:
// the first run after arming is a dry run that only reports, each later run first plans (a dry run), keeps only the
// duplicate sets that fit the preset's byte and file limits, and then clones those. The run log gets one report line
// per preset: what it would or did reclaim, why, and how much.

const log = logger.child({ component: "clones:auto-reclaim" });

/** Limits a newly armed preset gets unless the CLI says otherwise. */
export const DEFAULT_AUTO_MAX_BYTES = 5 * 1024 ** 3;
export const DEFAULT_AUTO_MAX_FILES = 500;

const UNITS: Record<string, number> = {
    b: 1,
    k: 1024,
    kb: 1024,
    m: 1024 ** 2,
    mb: 1024 ** 2,
    g: 1024 ** 3,
    gb: 1024 ** 3,
    t: 1024 ** 4,
    tb: 1024 ** 4,
};

/** "5GB", "500 MB", "1048576": a positive byte count, or null. Units are binary, as `formatBytes` prints them. */
export function parseByteLimit(raw: string): number | null {
    const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(raw);
    if (match === null) {
        return null;
    }

    const unit = UNITS[(match[2] ?? "").toLowerCase() || "b"];
    const value = Number(match[1]) * (unit ?? Number.NaN);
    return Number.isFinite(value) && value >= 1 ? Math.floor(value) : null;
}

/** Files one set rewrites: every copy except the kept one and the store copies that stay as they are. */
function filesOf(set: DuplicateSet): number {
    const store = new Set(set.storeMembers ?? []);
    return set.members.filter((member) => member !== set.keep && !store.has(member)).length;
}

export interface LimitedPlan {
    plan: ReclaimPlan;
    bytes: number;
    files: number;
    droppedSets: number;
    droppedBytes: number;
}

/** The plan cut to the limits: the biggest sets first, each kept only while the run's bytes and files still fit. */
export function limitPlan(plan: ReclaimPlan, limits: { maxBytes: number; maxFiles: number }): LimitedPlan {
    const ordered = [...plan.sets].sort((a, b) => b.reclaimable - a.reclaimable);
    const kept: DuplicateSet[] = [];
    let bytes = 0;
    let files = 0;
    let droppedBytes = 0;

    for (const set of ordered) {
        const setFiles = filesOf(set);

        if (bytes + set.reclaimable <= limits.maxBytes && files + setFiles <= limits.maxFiles) {
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
    limits: { maxBytes: number; maxFiles: number };
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

type AutoPreset = Preset & { auto: PresetAuto };

async function runOne(input: {
    preset: AutoPreset;
    deps: AutoReclaimDeps;
    dryRun: boolean;
}): Promise<AutoReclaimOutcome> {
    const { preset, deps, dryRun } = input;
    const auto = preset.auto;
    const limits = { maxBytes: auto.maxBytes, maxFiles: auto.maxFiles };
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
                    : `no duplicate set fits the limits (${formatBytes(limits.maxBytes)}, ${limits.maxFiles} files)`;
            return { ...outcome, action: "nothing", why };
        }

        if (dryRun) {
            return { ...outcome, action: "dry-run", why: "the scan task ran with --auto-dry-run" };
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
        return ["auto reclaim: no plan is marked auto (tools macos clones reclaim presets auto <id> --on)"];
    }

    return [
        `auto reclaim: ${outcomes.length} plan${outcomes.length === 1 ? "" : "s"} marked auto`,
        ...outcomes.map((o) => {
            const limits = `limits ${formatBytes(o.limits.maxBytes)}, ${o.limits.maxFiles} files`;
            const found = `the plan found ${formatBytes(o.planned.bytes)} in ${o.planned.sets} sets; ${o.withinLimits.sets} sets, ${o.withinLimits.files} files, ${formatBytes(o.withinLimits.bytes)} fit the ${limits}`;
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

/** The settings `presets auto <id> --on` stores: the given limits, else the old ones, else the defaults. A new
 *  arming always starts without `dryRunAt`, so its first run is a dry run. */
export function armedAuto(
    previous: PresetAuto | undefined,
    limits: { maxBytes?: number; maxFiles?: number }
): PresetAuto {
    return {
        enabled: true,
        maxBytes: limits.maxBytes ?? previous?.maxBytes ?? DEFAULT_AUTO_MAX_BYTES,
        maxFiles: limits.maxFiles ?? previous?.maxFiles ?? DEFAULT_AUTO_MAX_FILES,
    };
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
