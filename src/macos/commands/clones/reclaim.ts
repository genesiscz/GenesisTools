import { resolveKinds } from "@app/macos/commands/clones/kinds";
import { applyLogLevel } from "@app/macos/commands/clones/log-level";
import { KEEP_PARTNER_IDS } from "@app/macos/lib/clones/keep-partners";
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
    removePreset,
    savePreset,
    touchPreset,
} from "@app/macos/lib/clones/presets";
import {
    DEFAULT_MIN_REAL,
    type ReclaimPhase,
    type ReclaimPlan,
    type ReclaimSelector,
} from "@app/macos/lib/clones/reclaim";
import { JsonRenderer, resolveFormat, resolveRenderer } from "@app/macos/lib/clones/render/index";
import { resolveSelector, type SelectorError } from "@app/macos/lib/clones/selector";
import { TARGET_KIND_VALUES } from "@app/macos/lib/clones/targets";
import { isInteractive, suggestCommand, suggestEnumFlag } from "@genesiscz/utils/cli";
import { printLn } from "@genesiscz/utils/cli/stdout";
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

interface ReclaimOpts {
    dir: string[];
    worktreesOf?: string;
    targets?: string | boolean;
    keepPartners?: string | boolean;
    exclude: string[];
    minReal: string;
    format?: string;
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
    return cmd
        .argument("[dirs...]", "Directories to search (same as --dir)")
        .option("--dir <path>", "Directory to search (repeatable)", collect, [])
        .option("--worktrees-of <repo>", "Resolve this repo's git worktrees, siblings included")
        .option("--targets [kinds]", `What to scan: ${TARGET_KIND_VALUES.join(", ")}, or a find -name pattern`)
        .option(
            "--keep-partners [ids]",
            `Package-manager stores never rewritten (${KEEP_PARTNER_IDS.join(", ")}); only bun also offers its cached copies as keep candidates`
        )
        .option("--exclude <glob>", "Exclude glob (repeatable)", collect, [])
        .option("--min-real <bytes>", "Minimum per-file size to consider", String(DEFAULT_MIN_REAL));
}

function applyOutputFlags(cmd: Command): Command {
    return cmd
        .addOption(
            new Option("--format <format>", "Output format").choices(["auto", "table", "json", "jsonl"]).default("auto")
        )
        .option("-v, --verbose", "Verbose logging", false)
        .option(
            "--no-daemon",
            "Do not register the daily scan and cache reconciliation with tools daemon (clones daemon disable makes it permanent)"
        )
        .option("--silent", "Suppress non-essential output", false);
}

/** Print the exact message each selector failure used to print, and set the
 *  exit code that goes with it. */
function reportSelectorError(error: SelectorError, opts: ReclaimOpts, subcommand: string[]): void {
    if (error.kind === "no-dirs") {
        console.error("Nothing to search. Pass a directory, or --dir <path>.");
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

    console.error(`--min-real must be a positive whole number of bytes, got "${opts.minReal}".`);
    console.error(suggestCommand("tools macos clones", { add: ["--min-real", String(DEFAULT_MIN_REAL)], subcommand }));
    process.exitCode = 1;
}

async function selectorFrom(dirsArg: string[], opts: ReclaimOpts, verb: string[]): Promise<ReclaimSelector | null> {
    const subcommand = ["macos", "clones", "reclaim", ...verb];
    const dirs = [...dirsArg, ...opts.dir];
    if (dirs.length === 0) {
        reportSelectorError({ kind: "no-dirs" }, opts, subcommand);
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
        return null;
    }

    const resolved = resolveSelector({
        dirs,
        ...(opts.worktreesOf !== undefined ? { worktreesOf: opts.worktreesOf } : {}),
        targets,
        keepPartners,
        exclude: opts.exclude,
        minReal: opts.minReal,
    });
    if ("error" in resolved) {
        reportSelectorError(resolved.error, opts, subcommand);
        return null;
    }

    return resolved.selector;
}

function selectorFromPreset(preset: Preset): ReclaimSelector {
    return {
        dirs: preset.dirs,
        ...(preset.worktreesOf !== undefined ? { worktreesOf: preset.worktreesOf } : {}),
        targets: preset.targets,
        exclude: preset.exclude,
        minReal: preset.minReal,
        keepPartners: preset.keepPartners,
    };
}

function presetFromSelector(id: string, selector: ReclaimSelector, run?: { reclaimable: number }): Preset {
    const now = new Date().toISOString();
    return {
        id,
        dirs: selector.dirs,
        ...(selector.worktreesOf !== undefined ? { worktreesOf: selector.worktreesOf } : {}),
        targets: selector.targets,
        exclude: selector.exclude,
        minReal: selector.minReal,
        keepPartners: selector.keepPartners,
        createdAt: now,
        ...(run !== undefined ? { lastRunAt: now, lastReclaimable: run.reclaimable } : {}),
    };
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
            `${plan.roots.length} root(s) · ${plan.sets.length} set(s) · ${formatBytes(plan.totalReclaimable)}`
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
                savePreset(presetFromSelector(opts.save, selector, { reclaimable: plan.totalReclaimable }));
                recorded(opts, `preset "${opts.save}"`);
            }

            await printLn(renderPlan(plan, opts.format));
            process.exitCode = 0;
        });

    return cmd;
}

/** Confirm + clone. Returns the exit code. */
async function applyPlan(plan: ReclaimPlan, opts: ReclaimOpts, verb: string[]): Promise<number> {
    if (plan.sets.length === 0) {
        await printLn(renderPlan(plan, opts.format));
        return 0;
    }

    if (isInteractive()) {
        p.intro("clones reclaim apply");
        p.log.info(
            `${plan.sets.length} set(s) → clones · reclaim ${formatBytes(plan.totalReclaimable)} · ` +
                "rewrites in place, content-verified"
        );
        const ok = await p.typedConfirm({ message: 'Type "apply" to proceed', phrase: "apply" });
        if (!ok) {
            p.cancel("Aborted — nothing was changed.");
            return 0;
        }
    } else if (!opts.yes) {
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
        console.error(`INTEGRITY ABORT: ${applied.message}`);
        return 1;
    }

    if (applied.status === "clone-unsupported") {
        console.error(`Cannot apply: ${applied.message}`);
        return 1;
    }

    await printLn(resolveRenderer(resolveFormat(opts.format)).processReport(applied.report));
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

function renderPresetTable(presets: Preset[]): string {
    const table = createBoxTable(["ID", "DIRS", "TARGETS", "LAST"]);
    for (const preset of presets) {
        table.push([
            pc.white(preset.id),
            truncateDisplay(preset.dirs.map(collapsePathForDisplay).join(", "), 48),
            truncateDisplay(preset.targets.join(","), 24),
            preset.lastReclaimable !== undefined ? formatBytes(preset.lastReclaimable) : "—",
        ]);
    }

    return table.toString();
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
        .description("Print one preset")
        .action(async (id: string) => {
            const preset = getPreset(id);
            if (preset === null) {
                console.error(`Unknown preset "${id}".`);
                process.exit(1);
            }

            await printLn(SafeJSON.stringify(preset, null, 2));
        });

    const save = new Command("save").argument("<id>", "Preset id").description("Save a selector without scanning");
    applySelectorFlags(save).action(async (id: string, dirsArg: string[], opts: ReclaimOpts) => {
        const selector = await selectorFrom(dirsArg ?? [], opts, ["presets", "save", id]);
        if (selector === null) {
            return;
        }

        savePreset(presetFromSelector(id, selector));
        await printLn(`Saved preset ${id}.`);
        process.exitCode = 0;
    });
    group.addCommand(save);

    group
        .command("rm")
        .argument("<id>", "Preset id")
        .description("Delete one preset")
        .action(async (id: string) => {
            if (!removePreset(id)) {
                console.error(`Unknown preset "${id}".`);
                process.exit(1);
            }

            await printLn(`Removed preset ${id}.`);
        });

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
                console.error(`Unknown preset "${id}".`);
                const known = listPresets().map((x) => x.id);
                if (known.length > 0) {
                    console.error(`Known presets: ${known.join(", ")}`);
                }

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
                touchPreset(id, { lastRunAt: new Date().toISOString(), lastReclaimable: plan.totalReclaimable });
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
                touchPreset(id, { lastRunAt: new Date().toISOString(), lastReclaimable: plan.totalReclaimable });
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
        "Find the install trees under a directory (worktrees included) and share their duplicates"
    );
    group.addCommand(createPlanCommand());
    group.addCommand(createApplyCommand());
    group.addCommand(createPresetsCommand());
    return group;
}
