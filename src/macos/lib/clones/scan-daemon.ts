import { newProcessId, writeMeta } from "@app/macos/lib/clones/audit";
import {
    type AutoReclaimDeps,
    type AutoReclaimOutcome,
    formatAutoReclaimReport,
    realAutoReclaimDeps,
    runAutoReclaims,
} from "@app/macos/lib/clones/auto-reclaim";
import { cachePlan, planCacheKey, planCacheParams, stampRoots } from "@app/macos/lib/clones/cache";
import { collapseDuplicates } from "@app/macos/lib/clones/collapse";
import type { DuplicateSet } from "@app/macos/lib/clones/render/types";
import { loadClonesConfig } from "@app/macos/lib/clones/store";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { formatBytes, formatDuration } from "@genesiscz/utils/format";
import { logger, out } from "@genesiscz/utils/logger";
import { sendNotification } from "@genesiscz/utils/macos/notifications";

const log = logger.child({ component: "clones:scan-daemon" });

export interface DaemonScanArgs {
    watchedDirs?: string[];
    notify?: boolean;
    /** Smallest duplicate worth reporting, in bytes. Default: the config's `minReal`, else 10 MiB. */
    minReal?: number;
    /** The plans marked auto: run them, plan and report only, or leave them alone (default: the daemon's entry point
     *  passes "apply", so a caller that forgets the flag never clones anything). */
    autoReclaim?: "apply" | "dry-run" | "off";
    autoDeps?: AutoReclaimDeps;
}

/** What one watched folder holds: the bytes its duplicate copies would free, from how many sets. */
export interface DaemonScanRoot {
    root: string;
    reclaimable: number;
    sets: number;
}

export interface DaemonScanResult {
    scanned: boolean;
    /** Why nothing was scanned, when `scanned` is false. */
    reason?: string;
    reclaimable: number;
    dirs: number;
    processId?: string;
    roots: DaemonScanRoot[];
    sets: number;
    minReal: number;
    /** The plan the scan wrote: the cache key of the 60 s plan snapshot `optimize` reuses. */
    planKey?: string;
    /** One entry per plan marked auto; null when the scan ran with auto reclaim off. */
    auto: AutoReclaimOutcome[] | null;
    elapsedMs: number;
}

/** The watched folder a path lies in: the longest root that contains it. */
function rootOf(path: string, roots: string[]): string | null {
    let best: string | null = null;

    for (const root of roots) {
        const prefix = root.endsWith("/") ? root : `${root}/`;
        if ((path === root || path.startsWith(prefix)) && (best === null || root.length > best.length)) {
            best = root;
        }
    }

    return best;
}

/** Splits the reclaimable bytes over the watched folders: each copy that would be replaced counts for the folder
 *  it sits in (the kept copy frees nothing). */
export function reclaimableByRoot(sets: DuplicateSet[], roots: string[]): DaemonScanRoot[] {
    const byRoot = new Map<string, DaemonScanRoot>(roots.map((root) => [root, { root, reclaimable: 0, sets: 0 }]));

    for (const set of sets) {
        const touched = new Set<string>();

        for (const member of set.members) {
            if (member === set.keep) {
                continue;
            }

            const root = rootOf(member, roots);
            const entry = root === null ? undefined : byRoot.get(root);
            if (entry === undefined || root === null) {
                continue;
            }

            entry.reclaimable += set.eachBytes;
            touched.add(root);
        }

        for (const root of touched) {
            const entry = byRoot.get(root);
            if (entry) {
                entry.sets += 1;
            }
        }
    }

    return [...byRoot.values()];
}

/** The daily scan task: the watched-folder scan, then the plans marked auto. */
export async function runDaemonScan(args: DaemonScanArgs = {}): Promise<DaemonScanResult> {
    const scan = await scanWatchedDirs(args);
    const mode = args.autoReclaim ?? "off";
    const auto =
        mode === "off"
            ? null
            : await runAutoReclaims({ deps: args.autoDeps ?? realAutoReclaimDeps(), dryRun: mode === "dry-run" });
    return { ...scan, auto, elapsedMs: Math.round(performance.now() - scan.startedAt) };
}

/** Unattended dry-run scan of the watched folders (NEVER --apply). Writes the 60 s plan cache + a
 *  dry-run ProcessReport meta line, emits ONE notification. */
async function scanWatchedDirs(
    args: DaemonScanArgs
): Promise<Omit<DaemonScanResult, "auto" | "elapsedMs"> & { startedAt: number }> {
    const startedAt = performance.now();
    const cfg = await loadClonesConfig();
    const roots = args.watchedDirs ?? cfg.watchedDirs;
    const minReal = args.minReal ?? cfg.minReal ?? 10485760;
    if (!roots || roots.length === 0) {
        log.info("scan-daemon: no watchedDirs configured — nothing to do");
        return {
            scanned: false,
            reason: `no watched folders are configured (add one: ${toolCommand("macos clones config", "--add-dir", "<path>")})`,
            reclaimable: 0,
            dirs: 0,
            roots: [],
            sets: 0,
            minReal,
            startedAt,
        };
    }

    const exclude = cfg.exclude ?? [];
    // Surface only the actionable reclaim (what `optimize` would free) — a
    // measure pass would inflate the I/O without changing the notification.
    // The same filters threaded into cachePlan MUST be passed to
    // collapseDuplicates so the cached plan matches its cache key — otherwise
    // a follow-up `optimize` cache hit serves an unfiltered plan against a
    // filter-aware request.
    const rootStamps = stampRoots(roots);
    const sets = (await collapseDuplicates({ roots, minSize: minReal, exclude, pruneNames: [".git"] })).sets;
    const reclaimable = sets.reduce((s, x) => s + x.reclaimable, 0);
    const params = planCacheParams({ roots, minSize: minReal, exclude, nodeModules: Boolean(cfg.nodeModules) });

    await cachePlan(params, sets, rootStamps);

    const id = newProcessId();
    const now = new Date().toISOString();
    writeMeta({ id, state: "dry-run", roots, startedAt: now, endedAt: now, planCacheHit: false });

    if (args.notify !== false) {
        // Notification delivery can fail (missing permissions, Do Not Disturb,
        // notification-center daemon not running). Treat as best-effort — the
        // scan itself succeeded and recorded a dry-run meta line; the user can
        // always see the result via `tools macos clones optimize --list`.
        try {
            await sendNotification({
                title: "macos clones",
                message: `${formatBytes(reclaimable)} reclaimable across ${roots.length} dir(s) — run \`${toolCommand("macos clones optimize", "--apply")}\``,
            });
        } catch (err) {
            log.warn({ err }, "scan-daemon: notification delivery failed (scan results still recorded)");
        }
    }

    log.info({ reclaimable, dirs: roots.length, id }, "scan-daemon dry-run complete");
    return {
        scanned: true,
        reclaimable,
        dirs: roots.length,
        processId: id,
        roots: reclaimableByRoot(sets, roots),
        sets: sets.length,
        minReal,
        planKey: planCacheKey(params),
        startedAt,
    };
}

/** The per-run report the daemon keeps in the run log (stdout records): per watched folder what is reclaimable, the
 *  plan written, and the time it took. */
export function formatScanReport(result: DaemonScanResult): string[] {
    const auto = result.auto === null ? ["auto reclaim: off for this run"] : formatAutoReclaimReport(result.auto);

    if (!result.scanned) {
        return [
            `clones scan: nothing scanned, ${result.reason ?? "no reason recorded"}`,
            ...auto,
            `time: ${formatDuration(result.elapsedMs)}`,
        ];
    }

    return [
        `clones scan: ${result.dirs} watched folder${result.dirs === 1 ? "" : "s"}, duplicates of ${formatBytes(result.minReal)} or more`,
        ...result.roots.map((root) =>
            root.reclaimable > 0
                ? `  ${root.root}: ${formatBytes(root.reclaimable)} reclaimable in ${root.sets} duplicate set${root.sets === 1 ? "" : "s"}`
                : `  ${root.root}: nothing reclaimable`
        ),
        `total: ${formatBytes(result.reclaimable)} reclaimable in ${result.sets} duplicate set${result.sets === 1 ? "" : "s"}`,
        `plan written: dry-run plan snapshot ${result.planKey ?? "?"} (valid 60 s for ${toolCommand("macos clones optimize", "--apply")}), process log ${result.processId ?? "?"}`,
        ...auto,
        `time: ${formatDuration(result.elapsedMs)}`,
    ];
}

if (import.meta.main) {
    // `--auto-dry-run`: plan the auto presets and report, clone nothing. `--no-auto`: skip them.
    const argv = process.argv.slice(2);
    const autoReclaim = argv.includes("--no-auto") ? "off" : argv.includes("--auto-dry-run") ? "dry-run" : "apply";
    runDaemonScan({ notify: true, autoReclaim })
        .then((result) => {
            out.println(formatScanReport(result).join("\n"));
            process.exitCode = 0;
        })
        .catch((err) => {
            log.error({ err }, "scan-daemon failed");
            process.exitCode = 1;
        });
}
