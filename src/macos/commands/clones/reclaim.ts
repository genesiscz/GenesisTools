import { homedir } from "node:os";
import { applyLogLevel } from "@app/macos/commands/clones/log-level";
import { runOptimize } from "@app/macos/lib/clones/audit";
import { cachePlan, getCachedPlan, type PlanCacheParams, stampRoots, stampsMatch } from "@app/macos/lib/clones/cache";
import { RepoNotFoundError } from "@app/macos/lib/clones/discover";
import { FileMetaCache } from "@app/macos/lib/clones/file-meta-cache";
import { KEEP_PARTNER_IDS, type KeepPartnerId } from "@app/macos/lib/clones/keep-partners";
import {
    getPreset,
    listPresets,
    type Preset,
    removePreset,
    savePreset,
    touchPreset,
} from "@app/macos/lib/clones/presets";
import { clonesProfile } from "@app/macos/lib/clones/profile";
import { DEFAULT_MIN_REAL, planReclaim, type ReclaimPlan, type ReclaimSelector } from "@app/macos/lib/clones/reclaim";
import { appendReclaimEvent } from "@app/macos/lib/clones/reclaim-run";
import { resolveFormat, resolveRenderer } from "@app/macos/lib/clones/render/index";
import type { DuplicateSet } from "@app/macos/lib/clones/render/types";
import { TARGET_KIND_VALUES } from "@app/macos/lib/clones/targets";
import { isInteractive, parseVariadic, suggestCommand, suggestEnumFlag } from "@genesiscz/utils/cli";
import { printLn } from "@genesiscz/utils/cli/stdout";
import { ui } from "@genesiscz/utils/cli/ui";
import { formatBytes } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { CloneUnsupportedError } from "@genesiscz/utils/macos/apfs";
import * as p from "@genesiscz/utils/prompts/p";
import { Command, Option } from "commander";

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
    verbose?: boolean;
    silent?: boolean;
}

function shortenForSpinner(dir: string): string {
    const home = homedir();
    const rel = dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir;
    if (rel.length <= 80) {
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
        .option("--keep-partners [ids]", `Package-manager stores to use as keep-only: ${KEEP_PARTNER_IDS.join(", ")}`)
        .option("--exclude <glob>", "Exclude glob (repeatable)", collect, [])
        .option("--min-real <bytes>", "Minimum per-file size to consider", String(DEFAULT_MIN_REAL));
}

function applyOutputFlags(cmd: Command): Command {
    return cmd
        .addOption(
            new Option("--format <format>", "Output format").choices(["auto", "table", "json", "jsonl"]).default("auto")
        )
        .option("-v, --verbose", "Verbose logging", false)
        .option("--silent", "Suppress non-essential output", false);
}

/** Resolve an enumerated flag that may arrive empty. Returns null when the
 *  caller should stop (the suggestion was printed, or the prompt cancelled). */
async function resolveKinds(args: {
    raw: string | boolean | undefined;
    fallback: string[];
    flag: string;
    values: readonly string[];
    subcommand: string[];
}): Promise<string[] | null> {
    if (args.raw === undefined) {
        return args.fallback;
    }

    if (typeof args.raw === "string") {
        return parseVariadic(args.raw);
    }

    if (!isInteractive()) {
        console.error(suggestEnumFlag("tools macos clones", args.flag, args.values, { subcommand: args.subcommand }));
        process.exitCode = 1;
        return null;
    }

    const picked = await p.multiselect({
        message: `Which ${args.flag} do you want?`,
        options: args.values.map((v) => ({ value: v, label: v })),
        required: true,
    });
    if (p.isCancel(picked)) {
        p.cancel("Aborted.");
        return null;
    }

    return picked.map(String);
}

async function selectorFrom(dirsArg: string[], opts: ReclaimOpts, verb: string[]): Promise<ReclaimSelector | null> {
    const dirs = [...dirsArg, ...opts.dir];
    if (dirs.length === 0) {
        console.error("Nothing to search. Pass a directory, or --dir <path>.");
        console.error(
            suggestCommand("tools macos clones", {
                add: ["--dir", process.cwd()],
                subcommand: ["macos", "clones", "reclaim", ...verb],
            })
        );
        process.exitCode = 2;
        return null;
    }

    const subcommand = ["macos", "clones", "reclaim", ...verb];
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

    const unknownPartners = keepPartners.filter((k) => !(KEEP_PARTNER_IDS as readonly string[]).includes(k));
    if (unknownPartners.length > 0) {
        console.error(
            suggestEnumFlag("tools macos clones", "--keep-partners", KEEP_PARTNER_IDS, {
                subcommand,
                given: unknownPartners[0],
            })
        );
        process.exitCode = 1;
        return null;
    }

    const minReal = Number.parseInt(opts.minReal, 10);
    return {
        dirs,
        ...(opts.worktreesOf !== undefined ? { worktreesOf: opts.worktreesOf } : {}),
        targets,
        exclude: parseVariadic(opts.exclude),
        minReal: Number.isNaN(minReal) ? DEFAULT_MIN_REAL : minReal,
        keepPartners: keepPartners.filter((k): k is KeepPartnerId =>
            (KEEP_PARTNER_IDS as readonly string[]).includes(k)
        ),
    };
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

/** The 1-hour snapshot is keyed exactly like `optimize`'s, so a plan here can
 *  feed an `optimize --apply` on the same roots and the other way round. */
function planCacheParamsFor(selector: ReclaimSelector, roots: string[]): PlanCacheParams {
    return {
        roots,
        minSize: selector.minReal,
        include: [],
        exclude: selector.exclude,
        nodeModules: false,
        targets: selector.targets,
        worktreesOf: selector.worktreesOf ?? "",
        keepPartners: selector.keepPartners,
    };
}

function renderPlan(plan: ReclaimPlan, format: string | undefined): string {
    const fmt = resolveFormat(format);
    if (fmt === "json" || fmt === "jsonl") {
        return SafeJSON.stringify(plan, null, 2);
    }

    const lines: string[] = [];
    lines.push(
        resolveRenderer(fmt).duplicates({
            roots: plan.roots,
            sets: plan.sets,
            totalReclaimable: plan.totalReclaimable,
            grouped: false,
            hardStop: plan.roots,
        })
    );
    lines.push("");
    lines.push(
        `roots scanned: ${plan.roots.length}${plan.fromSnapshot ? " (sets reused from the plan snapshot)" : ""}`
    );
    if (plan.keepRoots.length > 0) {
        lines.push(`keep-only stores: ${plan.keepRoots.map((k) => `${k.id} (${k.root})`).join(", ")}`);
    }

    for (const s of plan.skipped) {
        lines.push(`skipped ${s.path} — ${s.reason}`);
    }

    lines.push(`run log: ${plan.runId}`);
    return lines.join("\n");
}

/** Reuse the snapshot only while every discovered root has the mtime it had
 *  when the plan was written. A branch switch rewrites `node_modules` under
 *  the same paths, and that snapshot would name packages that are gone. */
function snapshotHook(selector: ReclaimSelector): (roots: string[]) => Promise<DuplicateSet[] | null> {
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

        log.info({ roots: roots.length, ageMs: cached.ageMs, sets: cached.plan.length }, "plan snapshot reused");
        return cached.plan;
    };
}

/** Shared plan phase: spinner or stderr status lines, file-meta cache
 *  lifetime, SIGINT. Returns null when the run was aborted or refused. */
async function runPlan(
    selector: ReclaimSelector,
    opts: ReclaimOpts,
    verb: string[],
    reuseSnapshot: boolean
): Promise<ReclaimPlan | null> {
    const controller = new AbortController();
    const onSigint = (): void => {
        if (!controller.signal.aborted) {
            log.warn("SIGINT received, aborting reclaim");
            controller.abort(new Error("aborted by SIGINT"));
        }
    };
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigint);

    const quiet = Boolean(opts.silent);
    const spinner = isInteractive() && !quiet ? p.spinner() : null;
    let dirsSeen = 0;
    let lastDir = "";
    let tick: ReturnType<typeof setInterval> | null = null;
    if (spinner) {
        spinner.start("Discovering…");
        tick = setInterval(() => {
            if (lastDir) {
                spinner.message(`Scanned ${dirsSeen} dirs · in ${shortenForSpinner(lastDir)}`);
            }
        }, 100);
    }

    const cache = FileMetaCache.getInstance();
    const scanStartedAt = Date.now();
    try {
        const plan = await planReclaim(selector, {
            signal: controller.signal,
            cache,
            onDirEntered: (dir) => {
                dirsSeen += 1;
                lastDir = dir;
            },
            onPhase: (phase, detail) => {
                if (spinner) {
                    spinner.message(`${phase}: ${detail}`);
                } else if (!quiet) {
                    ui.dim(`${phase}: ${detail}`);
                }
            },
            ...(reuseSnapshot ? { snapshot: snapshotHook(selector) } : {}),
        });

        await cache.flush(scanStartedAt);
        await cache.flushDir(scanStartedAt);
        for (const root of plan.roots) {
            await cache.pruneScope(root, scanStartedAt);
            await cache.pruneDirScope(root, scanStartedAt);
        }

        spinner?.stop(
            `${plan.roots.length} root(s) · ${plan.sets.length} set(s) · ${formatBytes(plan.totalReclaimable)}`
        );
        clonesProfile.summary("reclaim");
        return plan;
    } catch (err) {
        spinner?.stop("reclaim failed");
        if (controller.signal.aborted) {
            log.warn({ err }, "reclaim aborted");
            process.exitCode = 130;
            return null;
        }

        if (err instanceof RepoNotFoundError) {
            console.error(err.message);
            if (err.candidates.length > 0) {
                console.error(`Repositories found: ${err.candidates.join(", ")}`);
                console.error(
                    suggestCommand("tools macos clones", {
                        remove: ["--worktrees-of"],
                        add: ["--worktrees-of", err.candidates[0]],
                        subcommand: ["macos", "clones", "reclaim", ...verb],
                    })
                );
            }

            process.exitCode = 1;
            return null;
        }

        throw err;
    } finally {
        if (tick) {
            clearInterval(tick);
        }

        cache.close();
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigint);
    }
}

function createPlanCommand(): Command {
    const cmd = new Command("plan").description("Discover the trees and show what apply would do (changes nothing)");
    applyOutputFlags(applySelectorFlags(cmd))
        .option("--save <id>", "Save this selector as a preset for later runs")
        .action(async (dirsArg: string[], opts: ReclaimOpts) => {
            applyLogLevel(opts);
            const selector = await selectorFrom(dirsArg ?? [], opts, ["plan"]);
            if (selector === null) {
                return;
            }

            const plan = await runPlan(selector, opts, ["plan"], false);
            if (plan === null) {
                return;
            }

            // Same-session shortcut only: an apply that follows can reuse this
            // snapshot while every root keeps its mtime. It expires in 1 hour.
            await cachePlan(planCacheParamsFor(selector, plan.roots), plan.sets, stampRoots(plan.roots));

            if (opts.save !== undefined) {
                savePreset(presetFromSelector(opts.save, selector, { reclaimable: plan.totalReclaimable }));
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

    try {
        const rep = runOptimize({
            roots: plan.roots,
            sets: plan.sets,
            planCacheHit: plan.fromSnapshot,
            keepOnlyRoots: plan.keepRoots.map((k) => k.root),
        });
        appendReclaimEvent(plan.runId, {
            phase: "apply",
            processId: rep.id,
            cloned: rep.totals.cloned,
            skipped: rep.totals.skipped,
            errors: rep.totals.errors,
            bytesReclaimed: rep.totals.bytesReclaimed,
        });
        clonesProfile.summary("reclaim apply");
        await printLn(resolveRenderer(resolveFormat(opts.format)).processReport(rep));
        return rep.totals.errors > 0 ? 1 : 0;
    } catch (err) {
        if (err instanceof CloneUnsupportedError) {
            appendReclaimEvent(plan.runId, { phase: "error", message: err.message });
            console.error(`Cannot apply: ${err.message}`);
            return 1;
        }

        throw err;
    }
}

function createApplyCommand(): Command {
    const cmd = new Command("apply").description("Discover, then convert the duplicates into clones (audited)");
    applyOutputFlags(applySelectorFlags(cmd))
        .option("--yes", "Non-interactive confirm (required in non-TTY)", false)
        .option("--no-cache", "Ignore the 1h plan snapshot; always rescan")
        .action(async (dirsArg: string[], opts: ReclaimOpts) => {
            applyLogLevel(opts);
            const selector = await selectorFrom(dirsArg ?? [], opts, ["apply"]);
            if (selector === null) {
                return;
            }

            const plan = await runPlan(selector, opts, ["apply"], opts.cache !== false);
            if (plan === null) {
                return;
            }

            process.exitCode = await applyPlan(plan, opts, ["apply"]);
        });

    return cmd;
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

                for (const preset of presets) {
                    const last =
                        preset.lastReclaimable !== undefined ? `  last=${formatBytes(preset.lastReclaimable)}` : "";
                    await printLn(
                        `${preset.id}  ${preset.dirs.join(", ")}  targets=${preset.targets.join(",")}${last}`
                    );
                }

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
        .option("--no-cache", "Ignore the 1h plan snapshot; always rescan")
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
            const plan = await runPlan(
                selector,
                opts,
                ["presets", "run", id],
                opts.apply === true && opts.cache !== false
            );
            if (plan === null) {
                return;
            }

            touchPreset(id, { lastRunAt: new Date().toISOString(), lastReclaimable: plan.totalReclaimable });
            if (opts.apply !== true) {
                await cachePlan(planCacheParamsFor(selector, plan.roots), plan.sets, stampRoots(plan.roots));
                await printLn(renderPlan(plan, opts.format));
                process.exitCode = 0;
                return;
            }

            process.exitCode = await applyPlan(plan, opts, ["presets", "run", id]);
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
