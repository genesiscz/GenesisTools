import { resolveKinds } from "@app/macos/commands/clones/kinds";
import { applyLogLevel } from "@app/macos/commands/clones/log-level";
import { addMinRealOptions } from "@app/macos/commands/clones/min-real-flags";
import { createStoresCommand } from "@app/macos/commands/clones/reclaim-stores";
import { armedAuto, formatLimits, mergeLimits } from "@app/macos/lib/clones/auto-reclaim";
import { KEEP_PARTNER_IDS, type KeepPartnerId, REWRITABLE_STORE_IDS } from "@app/macos/lib/clones/keep-partners";
import { type MinRealFlags, parseByteSize, parseCount } from "@app/macos/lib/clones/min-real";
import {
    applyReclaimPlan,
    type PlanRunHooks,
    runReclaimPlan,
    savePlanSnapshot,
} from "@app/macos/lib/clones/plan-runner";
import {
    getPreset,
    listPresets,
    type Preset,
    type PresetAuto,
    removePreset,
    savePreset,
    selectorFromPreset,
    touchPreset,
    updatePresetAuto,
} from "@app/macos/lib/clones/presets";
import type { ReclaimPhase, ReclaimPlan, ReclaimSelector } from "@app/macos/lib/clones/reclaim";
import { emitClonesError } from "@app/macos/lib/clones/render/envelope";
import { JsonRenderer, resolveFormat, resolveRenderer } from "@app/macos/lib/clones/render/index";
import { freeBytesLine } from "@app/macos/lib/clones/render/table";
import type { ProcessReport } from "@app/macos/lib/clones/render/types";
import { resolveSelector, type SelectorError } from "@app/macos/lib/clones/selector";
import { TARGET_KIND_VALUES } from "@app/macos/lib/clones/targets";
import { isInteractive, suggestCommand, suggestEnumFlag } from "@genesiscz/utils/cli";
import { printLn } from "@genesiscz/utils/cli/stdout";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { formatBytes } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { collapsePathForDisplay } from "@genesiscz/utils/paths.client";
import * as p from "@genesiscz/utils/prompts/p";
import { createBoxTable, truncateDisplay } from "@genesiscz/utils/table";
import { Command, Option } from "commander";
import pc from "picocolors";

const log = logger.child({ component: "clones:reclaim-cmd" });

function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
}

interface ReclaimOpts extends MinRealFlags {
    dir: string[];
    worktreesOf?: string;
    targets?: string | boolean;
    keepPartners?: string | boolean;
    rewriteStores?: string | boolean;
    keepUnfreeable?: boolean;
    exclude: string[];
    format?: string;
    json?: boolean;
    save?: string;
    yes?: boolean;
    /** commander `--no-cache` → false. Undefined when the verb has no such flag. */
    cache?: boolean;
    /** commander `--no-daemon` → false: do not register the daily daemon tasks. */
    daemon?: boolean;
    verbose?: boolean;
    silent?: boolean;
}

const SPINNER_PATH_MAX = 80;

function shortenForSpinner(dir: string): string {
    const rel = collapsePathForDisplay(dir);
    if (rel.length <= SPINNER_PATH_MAX) {
        return rel;
    }

    return `${rel.slice(0, 24)}…${rel.slice(-50)}`;
}

function applySelectorFlags(cmd: Command): Command {
    return addMinRealOptions(cmd, "Minimum per-file size to consider", "10MB")
        .argument("[dirs...]", "Directories to search (same as --dir)")
        .option("--dir <path>", "Directory to search (repeatable)", collect, [])
        .option("--worktrees-of <repo>", "Resolve this repo's git worktrees, siblings included")
        .option(
            "--targets [kinds]",
            `What to scan: ${TARGET_KIND_VALUES.join(", ")} (every file under each dir, not only install dirs), or a find -name pattern that matches directory names`
        )
        .option(
            "--keep-partners [ids]",
            `Package-manager stores never rewritten (${KEEP_PARTNER_IDS.join(", ")}); only bun also offers its cached copies as keep candidates`
        )
        .option(
            "--rewrite-stores [ids]",
            `Also rewrite a store file onto a byte-identical file of the same store (${REWRITABLE_STORE_IDS.join(", ")}); implies --keep-partners for it`
        )
        .option("--keep-unfreeable", "Keep sets that free nothing (dropped by default, so apply skips them)", false)
        .option("--exclude <glob>", "Exclude glob (repeatable)", collect, []);
}

function applyOutputFlags(cmd: Command): Command {
    return cmd
        .addOption(
            new Option("--format <format>", "Output format").choices(["auto", "table", "json", "jsonl"]).default("auto")
        )
        .option("-v, --verbose", "Verbose logging", false)
        .option(
            "--no-daemon",
            `Do not register the daily scan and cache reconciliation with ${toolCommand("daemon")} (clones daemon disable makes it permanent)`
        )
        .option("--silent", "Suppress non-essential output", false);
}

/** Print the exact message each selector failure used to print, and set the
 *  exit code that goes with it. */
/** The JSON envelope for a refused selector flag; a table run prints nothing here and keeps its stderr lines. */
function emitInvalidArguments(opts: ReclaimOpts, subcommand: string[], message: string): Promise<void> {
    return emitClonesError({
        format: opts.json ? "json" : opts.format,
        kind: "invalid-arguments",
        message,
        command: subcommand.slice(2).join(" "),
    });
}

async function reportSelectorError(error: SelectorError, opts: ReclaimOpts, subcommand: string[]): Promise<void> {
    const message =
        error.kind === "no-dirs"
            ? "Nothing to search. Pass a directory, or --dir <path>."
            : error.kind === "unknown-keep-partners"
              ? `Unknown --keep-partners: ${error.given.join(", ")}`
              : error.message;
    await emitInvalidArguments(opts, subcommand, message);
    if (error.kind === "no-dirs") {
        console.error(message);
        console.error(suggestCommand("tools macos clones", { add: ["--dir", process.cwd()], subcommand }));
        process.exitCode = 2;
        return;
    }

    if (error.kind === "unknown-keep-partners") {
        console.error(
            suggestEnumFlag("tools macos clones", "--keep-partners", KEEP_PARTNER_IDS, {
                subcommand,
                given: error.given[0],
            })
        );
        process.exitCode = 1;
        return;
    }

    console.error(message);
    console.error(suggestCommand("tools macos clones", { add: ["--min-real", "10MB"], subcommand }));
    process.exitCode = 1;
}

async function selectorFrom(dirsArg: string[], opts: ReclaimOpts, verb: string[]): Promise<ReclaimSelector | null> {
    const subcommand = ["macos", "clones", "reclaim", ...verb];
    const dirs = [...dirsArg, ...opts.dir];
    if (dirs.length === 0) {
        await reportSelectorError({ kind: "no-dirs" }, opts, subcommand);
        return null;
    }

    const targets = await resolveKinds({
        raw: opts.targets,
        fallback: ["gitignored"],
        flag: "--targets",
        values: TARGET_KIND_VALUES,
        subcommand,
    });
    if (targets === null) {
        await emitInvalidArguments(opts, subcommand, "Invalid --targets selection");
        return null;
    }

    const keepPartners = await resolveKinds({
        raw: opts.keepPartners,
        fallback: [],
        flag: "--keep-partners",
        values: KEEP_PARTNER_IDS,
        subcommand,
    });
    if (keepPartners === null) {
        await emitInvalidArguments(opts, subcommand, "Invalid --keep-partners selection");
        return null;
    }

    const rewriteStores = await resolveKinds({
        raw: opts.rewriteStores,
        fallback: [],
        flag: "--rewrite-stores",
        values: REWRITABLE_STORE_IDS,
        subcommand,
    });
    if (rewriteStores === null) {
        await emitInvalidArguments(opts, subcommand, "Invalid --rewrite-stores selection");
        return null;
    }

    const isRewritable = (s: string): s is KeepPartnerId => (REWRITABLE_STORE_IDS as readonly string[]).includes(s);
    const unknownStore = rewriteStores.find((s) => !isRewritable(s));
    if (unknownStore !== undefined) {
        await emitInvalidArguments(opts, subcommand, `Unknown --rewrite-stores: ${unknownStore}`);
        console.error(
            suggestEnumFlag("tools macos clones", "--rewrite-stores", REWRITABLE_STORE_IDS, {
                subcommand,
                given: unknownStore,
            })
        );
        process.exitCode = 1;
        return null;
    }

    const resolved = resolveSelector({
        dirs,
        ...(opts.worktreesOf !== undefined ? { worktreesOf: opts.worktreesOf } : {}),
        targets,
        keepPartners,
        exclude: opts.exclude,
        minReal: opts,
    });
    if ("error" in resolved) {
        await reportSelectorError(resolved.error, opts, subcommand);
        return null;
    }

    return {
        ...resolved.selector,
        ...(rewriteStores.length > 0 ? { rewriteStores: rewriteStores.filter(isRewritable) } : {}),
        ...(opts.keepUnfreeable === true ? { keepUnfreeable: true } : {}),
    };
}

/** `--max-bytes` / `--max-files`: undefined keeps the stored limit, null clears it (`none`), NaN is invalid. */
function limitFlag(raw: string | undefined, parse: (raw: string) => number | null): number | null | undefined {
    if (raw === undefined) {
        return undefined;
    }

    if (raw.trim().toLowerCase() === "none") {
        return null;
    }

    return parse(raw) ?? Number.NaN;
}

/** The record `presets save` / `plan --save` writes. Saving over an existing id is an edit: it keeps `createdAt`,
 *  the auto settings and the last run, so a UI edit never disarms auto. When the selector itself changed, an armed
 *  preset loses `dryRunAt`, so its next run is a dry run of the new selector. */
function presetFromSelector(id: string, selector: ReclaimSelector, run?: { reclaimable: number }): Preset {
    const now = new Date().toISOString();
    const previous = getPreset(id);
    const fresh: Preset = {
        id,
        dirs: selector.dirs,
        ...(selector.worktreesOf !== undefined ? { worktreesOf: selector.worktreesOf } : {}),
        targets: selector.targets,
        exclude: selector.exclude,
        minReal: selector.minReal,
        keepPartners: selector.keepPartners,
        ...(selector.rewriteStores !== undefined ? { rewriteStores: selector.rewriteStores } : {}),
        ...(selector.keepUnfreeable === true ? { keepUnfreeable: true } : {}),
        createdAt: previous?.createdAt ?? now,
        ...(run !== undefined
            ? { lastRunAt: now, lastReclaimable: run.reclaimable }
            : previous?.lastRunAt !== undefined
              ? {
                    lastRunAt: previous.lastRunAt,
                    ...(previous.lastReclaimable !== undefined ? { lastReclaimable: previous.lastReclaimable } : {}),
                }
              : {}),
    };
    if (previous?.auto === undefined) {
        return fresh;
    }

    const sameSelector =
        SafeJSON.stringify(selectorFromPreset(previous)) === SafeJSON.stringify(selectorFromPreset(fresh));
    const { dryRunAt, ...auto } = previous.auto;
    return { ...fresh, auto: sameSelector && dryRunAt !== undefined ? { ...auto, dryRunAt } : auto };
}

function renderPlan(plan: ReclaimPlan, format: string | undefined): string {
    const fmt = resolveFormat(format);
    if (fmt === "jsonl") {
        return new JsonRenderer().planJsonl(plan);
    }

    return resolveRenderer(fmt).plan(plan);
}

/** Spinner label for the stage that starts once `phase` is done. */
const NEXT_STAGE: Record<ReclaimPhase, string> = {
    discover: "Loading cache…",
    cache: "Walking…",
    walk: "Hashing…",
    hash: "Collapsing…",
    collapse: "Finishing…",
    snapshot: "Finishing…",
};

/** A line for something that was written, printed after the spinner is gone. */
function recorded(opts: ReclaimOpts, text: string): void {
    if (!opts.silent) {
        ui.ok(`recorded: ${text}`);
    }
}

async function runPlan({
    selector,
    opts,
    verb,
    reuseSnapshot,
}: {
    selector: ReclaimSelector;
    opts: ReclaimOpts;
    verb: string[];
    reuseSnapshot: boolean;
}): Promise<ReclaimPlan | null> {
    const quiet = Boolean(opts.silent);
    let spinner = isInteractive() && !quiet ? p.spinner() : null;
    let dirsSeen = 0;
    let filesSeen = 0;
    let lastDir = "";
    let tick: ReturnType<typeof setInterval> | null = null;
    if (spinner) {
        spinner.start("Discovering…");
        tick = setInterval(() => {
            if (lastDir) {
                // The native walk counts FILES (it has no per-directory event);
                // the in-process one counts directories. Label what is counted.
                const seen = filesSeen > 0 ? `${filesSeen} files` : `${dirsSeen} dirs`;
                spinner?.message(`Scanned ${seen} · in ${shortenForSpinner(lastDir)}`);
            }
        }, 100);
    }

    const hooks: PlanRunHooks = {
        onDirEntered: (dir) => {
            dirsSeen += 1;
            lastDir = dir;
        },
        onWalkProgress: (progress) => {
            filesSeen = progress.files;
            lastDir = progress.dir;
        },
        // One persistent line per finished stage. In a TTY the running spinner
        // becomes that line and a fresh spinner starts on the next stage;
        // piped output gets the same line through `ui.ok`.
        onPhase: (phase, detail) => {
            const line = `${phase}: ${detail}`;
            if (spinner) {
                spinner.stop(line);
                spinner = p.spinner();
                spinner.start(NEXT_STAGE[phase]);
            } else if (!quiet) {
                ui.ok(line);
            }
        },
        onRecorded: (text) => recorded(opts, text),
        onFailed: () => spinner?.stop("reclaim failed"),
    };

    try {
        const result = await runReclaimPlan({
            selector,
            reuseSnapshot,
            registerDaemon: opts.daemon !== false,
            hooks,
        });

        if (result.status === "aborted") {
            process.exitCode = 130;
            return null;
        }

        if (result.status === "repo-not-found") {
            await emitClonesError({
                format: opts.json ? "json" : opts.format,
                kind: "repo-not-found",
                message: result.error.message,
                command: ["reclaim", ...verb].join(" "),
            });
            console.error(result.error.message);
            if (result.error.candidates.length > 0) {
                console.error(`Repositories found: ${result.error.candidates.join(", ")}`);
                console.error(
                    suggestCommand("tools macos clones", {
                        remove: ["--worktrees-of"],
                        add: ["--worktrees-of", result.error.candidates[0]],
                        subcommand: ["macos", "clones", "reclaim", ...verb],
                    })
                );
            }

            process.exitCode = 1;
            return null;
        }

        const plan = result.plan;
        spinner?.stop(
            `${plan.roots.length} root(s) · ${plan.sets.length} set(s) · ${formatBytes(plan.totalFreeable)} freeable`
        );
        return plan;
    } finally {
        if (tick) {
            clearInterval(tick);
        }
    }
}

function createPlanCommand(): Command {
    const cmd = new Command("plan").description(
        "Discover the trees and show what apply would do (rewrites nothing; registers the daily daemon tasks once unless they are disabled, --no-daemon to skip this run)"
    );
    applyOutputFlags(applySelectorFlags(cmd))
        .option("--save <id>", "Save this selector as a preset for later runs")
        .action(async (dirsArg: string[], opts: ReclaimOpts) => {
            applyLogLevel(opts);
            const selector = await selectorFrom(dirsArg ?? [], opts, ["plan"]);
            if (selector === null) {
                return;
            }

            const plan = await runPlan({ selector, opts, verb: ["plan"], reuseSnapshot: false });
            if (plan === null) {
                return;
            }

            // Hand-off shortcut only: the apply typed right after this one can
            // reuse the snapshot while every root and every member it names is
            // unchanged. It expires in 60 s because the stamps prove freshness
            // and never completeness, and apply byte-verifies every pair.
            await savePlanSnapshot(selector, plan);
            recorded(
                opts,
                `plan snapshot for apply (valid 60 s, and only for the duplicates it already names) · run log ${plan.runId}`
            );

            if (opts.save !== undefined) {
                savePreset(presetFromSelector(opts.save, selector, { reclaimable: plan.totalFreeable }));
                recorded(opts, `preset "${opts.save}"`);
            }

            await printLn(renderPlan(plan, opts.format));
            process.exitCode = 0;
        });

    return cmd;
}

/** The plan's projection, carried inside the apply JSON so a caller sees promised and measured side by side. */
export interface ApplyPlanSummary {
    runId: string;
    totalReclaimable: number;
    totalFreeable: number;
    totalFreeableUpTo: number;
    sets: number;
}

export type ApplyJsonReport = ProcessReport & { plan: ApplyPlanSummary };

export function applyJsonReport(report: ProcessReport, plan: ReclaimPlan): ApplyJsonReport {
    return {
        ...report,
        plan: {
            runId: plan.runId,
            totalReclaimable: plan.totalReclaimable,
            totalFreeable: plan.totalFreeable,
            totalFreeableUpTo: plan.totalFreeableUpTo,
            sets: plan.sets.length,
        },
    };
}

/** Confirm + clone. Returns the exit code. */
async function applyPlan(plan: ReclaimPlan, opts: ReclaimOpts, verb: string[]): Promise<number> {
    const command = ["reclaim", ...verb].join(" ");
    if (plan.sets.length === 0) {
        await printLn(renderPlan(plan, opts.format));
        return 0;
    }

    if (isInteractive()) {
        p.intro("clones reclaim apply");
        p.log.info(
            `${plan.sets.length} set(s) → clones · frees ${formatBytes(plan.totalFreeable)} ` +
                `(naive ${formatBytes(plan.totalReclaimable)}) · ` +
                "rewrites in place, content-verified"
        );
        const ok = await p.typedConfirm({ message: 'Type "apply" to proceed', phrase: "apply" });
        if (!ok) {
            p.cancel("Aborted — nothing was changed.");
            return 0;
        }
    } else if (!opts.yes) {
        await emitClonesError({
            format: opts.format,
            kind: "confirm-required",
            message: "reclaim apply requires confirmation. In non-interactive mode pass --yes.",
            command,
            extra: { sets: plan.sets.length, totalFreeable: plan.totalFreeable, planRunId: plan.runId },
        });
        console.error("reclaim apply requires confirmation. In non-interactive mode pass --yes.");
        console.error(
            suggestCommand("tools macos clones", {
                add: ["--yes"],
                subcommand: ["macos", "clones", "reclaim", ...verb],
            })
        );
        return 1;
    }

    const applied = applyReclaimPlan(plan);
    if (applied.status === "integrity") {
        const message = `INTEGRITY ABORT: ${applied.message}`;
        await emitClonesError({
            format: opts.format,
            kind: "integrity",
            message,
            command,
            extra: { planRunId: plan.runId },
        });
        console.error(message);
        return 1;
    }

    if (applied.status === "clone-unsupported") {
        const message = `Cannot apply: ${applied.message}`;
        await emitClonesError({
            format: opts.format,
            kind: "clone-unsupported",
            message,
            command,
            extra: { planRunId: plan.runId },
        });
        console.error(message);
        return 1;
    }

    const fmt = resolveFormat(opts.format);
    if (fmt === "table") {
        await printLn(resolveRenderer(fmt).processReport(applied.report));
    } else {
        const report = applyJsonReport(applied.report, plan);
        await printLn(fmt === "jsonl" ? SafeJSON.stringify(report) : SafeJSON.stringify(report, null, 2));
    }
    if (fmt === "table") {
        // The three numbers side by side: what the plan promised, what the
        // kernel said each copy held privately, and what statfs saw.
        const statfs = freeBytesLine(applied.report);
        await printLn(
            `projected free ${formatBytes(plan.totalFreeable)}` +
                (plan.totalFreeableUpTo > plan.totalFreeable ? ` (up to ${formatBytes(plan.totalFreeableUpTo)})` : "") +
                ` · measured ${formatBytes(applied.report.totals.bytesReclaimed)}` +
                (statfs !== null ? ` · ${statfs}` : "")
        );
    }

    return applied.report.totals.errors > 0 ? 1 : 0;
}

function createApplyCommand(): Command {
    const cmd = new Command("apply").description("Discover, then convert the duplicates into clones (audited)");
    applyOutputFlags(applySelectorFlags(cmd))
        .option("--yes", "Non-interactive confirm (required in non-TTY)", false)
        .option("--no-cache", "Ignore the 60 s plan snapshot; always rescan")
        .action(async (dirsArg: string[], opts: ReclaimOpts) => {
            applyLogLevel(opts);
            const selector = await selectorFrom(dirsArg ?? [], opts, ["apply"]);
            if (selector === null) {
                return;
            }

            const plan = await runPlan({ selector, opts, verb: ["apply"], reuseSnapshot: opts.cache !== false });
            if (plan === null) {
                return;
            }

            process.exitCode = await applyPlan(plan, opts, ["apply"]);
        });

    return cmd;
}

function autoCell(preset: Preset): string {
    const auto = preset.auto;
    if (auto?.enabled !== true) {
        return "off";
    }

    const limits = formatLimits(auto);
    return auto.dryRunAt === undefined ? `on, dry run next (${limits})` : `on (${limits})`;
}

function renderPresetTable(presets: Preset[]): string {
    const table = createBoxTable(["ID", "DIRS", "TARGETS", "LAST", "AUTO"]);
    for (const preset of presets) {
        table.push([
            pc.white(preset.id),
            truncateDisplay(preset.dirs.map(collapsePathForDisplay).join(", "), 48),
            truncateDisplay(preset.targets.join(","), 24),
            preset.lastReclaimable !== undefined ? formatBytes(preset.lastReclaimable) : "—",
            autoCell(preset),
        ]);
    }

    return table.toString();
}

async function unknownPreset(id: string, command: string, json: boolean): Promise<void> {
    const known = listPresets().map((x) => x.id);
    await emitClonesError({
        format: json ? "json" : "table",
        kind: "unknown-preset",
        message: `Unknown preset "${id}".`,
        command,
        extra: { presetId: id, known },
    });
    console.error(`Unknown preset "${id}".${known.length > 0 ? ` Known presets: ${known.join(", ")}` : ""}`);
}

function createPresetsCommand(): Command {
    const group = new Command("presets").description("Saved reclaim selectors");

    group
        .command("list")
        .description("List saved presets")
        .addOption(new Option("--format <format>", "Output format").choices(["auto", "table", "json"]).default("auto"))
        .action(async (opts: { format?: string }) => {
            const presets = listPresets();
            if (resolveFormat(opts.format) === "table") {
                if (presets.length === 0) {
                    await printLn("No presets. Save one with: reclaim plan --dir <path> --save <id>");
                    return;
                }

                await printLn(renderPresetTable(presets));
                return;
            }

            await printLn(SafeJSON.stringify({ presets }, null, 2));
        });

    group
        .command("show")
        .argument("<id>", "Preset id")
        .description("Print one preset (always JSON)")
        .action(async (id: string) => {
            const preset = getPreset(id);
            if (preset === null) {
                await unknownPreset(id, "reclaim presets show", true);
                process.exit(1);
            }

            await printLn(SafeJSON.stringify(preset, null, 2));
        });

    const save = new Command("save").argument("<id>", "Preset id").description("Save a selector without scanning");
    applySelectorFlags(save)
        .option("--json", "print {preset} as JSON")
        .action(async (id: string, dirsArg: string[], opts: ReclaimOpts & { json?: boolean }) => {
            const selector = await selectorFrom(dirsArg ?? [], opts, ["presets", "save", id]);
            if (selector === null) {
                return;
            }

            const preset = presetFromSelector(id, selector);
            savePreset(preset);
            await printLn(opts.json ? SafeJSON.stringify({ preset }, null, 2) : `Saved preset ${id}.`);
            process.exitCode = 0;
        });
    group.addCommand(save);

    group
        .command("rm")
        .argument("<id>", "Preset id")
        .description("Delete one preset")
        .option("--json", "print {removed} as JSON")
        .action(async (id: string, opts: { json?: boolean }) => {
            if (!removePreset(id)) {
                await unknownPreset(id, "reclaim presets rm", Boolean(opts.json));
                process.exit(1);
            }

            await printLn(opts.json ? SafeJSON.stringify({ removed: id }, null, 2) : `Removed preset ${id}.`);
        });

    group
        .command("auto")
        .argument("<id>", "Preset id")
        .description(
            "Let the daily scan task run this plan on its own: the first run after --on is a dry run, every later run clones only the duplicate sets that fit the limits"
        )
        .option("--on", "mark the plan auto (its next scan-task run is a dry run)")
        .option("--off", "stop running the plan on its own")
        .option(
            "--max-bytes <size>",
            "most bytes cloned per run, e.g. 50GB; none removes the limit (default: no limit)"
        )
        .option("--max-files <n>", "most files cloned per run; none removes the limit (default: no limit)")
        .option("--json", "print the preset as JSON")
        .action(
            async (
                id: string,
                opts: { on?: boolean; off?: boolean; maxBytes?: string; maxFiles?: string; json?: boolean }
            ) => {
                const preset = getPreset(id);
                if (preset === null) {
                    await unknownPreset(id, "reclaim presets auto", Boolean(opts.json));
                    process.exitCode = 1;
                    return;
                }

                if (opts.on && opts.off) {
                    console.error("Pass --on or --off, not both.");
                    process.exitCode = 1;
                    return;
                }

                const maxBytes = limitFlag(opts.maxBytes, parseByteSize);
                const maxFiles = limitFlag(opts.maxFiles, parseCount);
                if (Number.isNaN(maxBytes) || Number.isNaN(maxFiles)) {
                    console.error(
                        "--max-bytes takes a size such as 50GB or 500MB, --max-files a whole number above 0; none removes either limit."
                    );
                    process.exitCode = 1;
                    return;
                }

                const limits = { maxBytes, maxFiles };
                const changesLimits = limits.maxBytes !== undefined || limits.maxFiles !== undefined;
                let next: Preset | null = preset;
                if (opts.on) {
                    next = updatePresetAuto(id, armedAuto(preset.auto, limits));
                } else if (opts.off) {
                    // Limits passed with --off are saved too, so the next --on runs with them.
                    if (preset.auto || changesLimits) {
                        const previous: Partial<PresetAuto> = preset.auto ?? {};
                        const { maxBytes: _bytes, maxFiles: _files, ...rest } = previous;
                        next = updatePresetAuto(id, {
                            ...rest,
                            enabled: false,
                            dryRunAt: undefined,
                            ...mergeLimits(preset.auto, limits),
                        });
                    }
                } else if (preset.auto && changesLimits) {
                    const { maxBytes: _bytes, maxFiles: _files, ...rest } = preset.auto;
                    next = updatePresetAuto(id, { ...rest, ...mergeLimits(preset.auto, limits) });
                }

                if (opts.json) {
                    await printLn(SafeJSON.stringify(next, null, 2));
                    return;
                }

                await printLn(`${id}: auto ${next ? autoCell(next) : "off"}`);
            }
        );

    const run = new Command("run")
        .argument("<id>", "Preset id")
        .description("Re-run a preset: plan, then apply after confirmation");
    applyOutputFlags(run)
        .option("--apply", "Apply instead of planning only", false)
        .option("--yes", "Non-interactive confirm (required in non-TTY)", false)
        .option("--no-cache", "Ignore the 60 s plan snapshot; always rescan")
        .action(async (id: string, opts: ReclaimOpts & { apply?: boolean }) => {
            applyLogLevel(opts);
            const preset = getPreset(id);
            if (preset === null) {
                await unknownPreset(id, "reclaim presets run", resolveFormat(opts.format) !== "table");
                process.exit(1);
            }

            const selector = selectorFromPreset(preset);
            const plan = await runPlan({
                selector,
                opts,
                verb: ["presets", "run", id],
                reuseSnapshot: opts.apply === true && opts.cache !== false,
            });
            if (plan === null) {
                return;
            }

            if (opts.apply !== true) {
                touchPreset(id, { lastRunAt: new Date().toISOString(), lastReclaimable: plan.totalFreeable });
                await savePlanSnapshot(selector, plan);
                recorded(
                    opts,
                    `plan snapshot for apply (valid 60 s, and only for the duplicates it already names) · run log ${plan.runId}`
                );
                await printLn(renderPlan(plan, opts.format));
                process.exitCode = 0;
                return;
            }

            const code = await applyPlan(plan, opts, ["presets", "run", id]);
            // Only a run that actually applied is a run: a cancelled prompt, a
            // missing --yes or a refused clone used to be recorded as one.
            if (code === 0) {
                touchPreset(id, { lastRunAt: new Date().toISOString(), lastReclaimable: plan.totalFreeable });
            } else {
                log.info({ id, code }, "preset run not recorded — apply did not complete");
            }

            process.exitCode = code;
        });
    group.addCommand(run);
    return group;
}

export function createReclaimCommand(): Command {
    const group = new Command("reclaim").description(
        "Find the install trees under a directory (worktrees included) and share their duplicates; --targets all takes every file"
    );
    group.addCommand(createPlanCommand());
    group.addCommand(createApplyCommand());
    group.addCommand(createPresetsCommand());
    group.addCommand(createStoresCommand());
    return group;
}
