// `tools du index build|update|query|diff|schedule`: thin commander adapters over
// lib/index/*. Every machine form (`--format json|ndjson`) writes to stdout only;
// human progress goes to stderr.

import { isAbsolute, resolve } from "node:path";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { formatTable } from "@genesiscz/utils/table";
import { type Command, Option } from "commander";
import pc from "picocolors";
import { humanBytes } from "../format";
import { durationToCutoff, intOpt } from "../options";
import { buildIndex } from "./build";
import { indexTaskStatus, scheduleIndexTask, unscheduleIndexTask } from "./daemon-task";
import { defaultDbPath } from "./db";
import { diffIndex } from "./diff";
import { QUERY_SORTS, type QuerySort, queryInfo, queryLargest, queryPath } from "./query";
import type {
    BuildResult,
    DiffResult,
    IndexEvent,
    IndexFormat,
    QueryFound,
    QueryInfo,
    QueryLargest,
    QueryNotFound,
    ScheduleStatus,
    UpdateResult,
} from "./types";
import { errorEvent, IndexError } from "./types";
import { updateIndex } from "./update";

const log = logger.child({ component: "du:index:cli" });
const GiB = 1024 ** 3;

function resolveFormat(format: string | undefined): IndexFormat {
    if (format === "human" || format === "json" || format === "ndjson") {
        return format;
    }

    return process.stdout.isTTY ? "human" : "json";
}

function printJson(value: unknown, format: IndexFormat): void {
    const text =
        format === "ndjson"
            ? SafeJSON.stringify(value, { strict: true })
            : SafeJSON.stringify(value, { strict: true }, 2);
    out.print(`${text}\n`);
}

function absPath(p: string): string {
    return isAbsolute(p) ? p : resolve(p);
}

/** Runs one subcommand; an error becomes the `error` object (machine formats) or a message, plus its exit code. */
async function run(command: string, format: IndexFormat, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
    } catch (err) {
        const e =
            err instanceof IndexError
                ? err
                : new IndexError("failed", err instanceof Error ? err.message : String(err));
        if (!(err instanceof IndexError)) {
            log.error({ err, command }, "du index command failed");
        }

        if (format === "human") {
            out.error(e.message);
        } else {
            printJson(errorEvent(command, e), format);
        }

        process.exitCode = e.exitCode;
    }
}

/** EOF on stdin aborts: the app holds the pipe open, so the child ends when the app quits. */
function stopOnStdin(enabled: boolean | undefined, signal: AbortSignal): AbortSignal {
    if (!enabled) {
        return signal;
    }

    const owner = new AbortController();
    const abort = () => owner.abort();
    signal.addEventListener("abort", abort, { once: true });
    process.stdin.on("end", abort);
    process.stdin.resume();
    if (process.stdin.readableEnded) {
        owner.abort();
    }

    return owner.signal;
}

function releaseStdin(enabled: boolean | undefined): void {
    if (enabled) {
        process.stdin.removeAllListeners("end");
        process.stdin.pause();
    }
}

function humanProgress(): (e: IndexEvent) => void {
    return (e) => {
        if (e.type === "blocked") {
            out.printErr(
                `\n${pc.yellow("blocked")} ${e.path}: no progress for ${Math.round(e.waited_ms / 1000)} s, skipped\n`
            );
        } else if (e.type === "progress") {
            out.printErr(
                `\r${pc.dim("walking")} ${e.files.toLocaleString()} files, ${e.dirs.toLocaleString()} dirs, ${humanBytes(e.bytes)} ` +
                    `${pc.dim(`(${e.files_per_s.toLocaleString()} files/s)`)}   `
            );
        } else if (e.type === "phase" && e.phase === "ingest") {
            out.printErr("\n");
        }
    };
}

function renderBuild(r: BuildResult): void {
    out.println(pc.bold(`Index of ${r.root}`));
    out.println(
        `  ${humanBytes(r.alloc_bytes)} allocated, ${r.files.toLocaleString()} files, ${r.dirs.toLocaleString()} dirs ` +
            `(${r.stored_dirs.toLocaleString()} stored, ${r.folded_dirs.toLocaleString()} folded below ${humanBytes(r.min_dir_bytes)})`
    );
    if (r.private_bytes !== null) {
        out.println(`  ${humanBytes(r.alloc_bytes - r.private_bytes)} shared with clones or hard links`);
    }

    out.println(
        `  walk ${(r.walk_ms / 1000).toFixed(1)} s, ingest ${(r.ingest_ms / 1000).toFixed(1)} s, total ${(r.elapsed_ms / 1000).toFixed(1)} s, ` +
            `database ${humanBytes(r.db_bytes)} at ${r.db}`
    );
    if (r.denied_dirs + r.read_errors > 0) {
        out.println(pc.yellow(`  ${r.denied_dirs} denied, ${r.read_errors} read errors (those folders are flagged)`));
    }

    for (const p of [...r.skipped_cloud, ...r.skipped_mounts]) {
        out.println(pc.dim(`  skipped ${p}`));
    }

    for (const p of r.blocked_paths) {
        out.println(
            pc.yellow(
                `  blocked ${p}: no answer for its listing (macOS may be asking for access to another app's data)`
            )
        );
    }
}

function renderUpdate(r: UpdateResult): void {
    if (r.deferred) {
        out.println(`An index build is running; ${r.queued} path(s) were queued for the next update.`);
        return;
    }

    for (const reg of r.regions) {
        const sign = reg.delta.alloc_bytes >= 0 ? "+" : "-";
        out.println(
            `${reg.owner}: ${sign}${humanBytes(Math.abs(reg.delta.alloc_bytes))}, ${reg.files.toLocaleString()} files walked in ${reg.walk_ms} ms`
        );
    }

    out.println(
        pc.dim(`${r.regions.length} region(s), ${r.promoted} promoted, ${r.removed} removed, ${r.elapsed_ms} ms`)
    );
    for (const p of r.ignored) {
        out.println(pc.yellow(`ignored (outside the index or excluded): ${p}`));
    }
}

function renderQuery(r: QueryFound | QueryNotFound): void {
    if (!r.found) {
        out.println(
            r.reason === "outside_root"
                ? `${r.path} is outside the indexed root ${r.root}.`
                : r.reason === "missing"
                  ? `${r.path} does not exist. Its bytes would count in ${r.folded_in}.`
                  : `${r.path} is folded into ${r.folded_in} (its subtree is below the size cutoff).`
        );
        out.println(pc.dim(`For its exact tree: ${r.hint}`));
        return;
    }

    const age = r.as_of.age_s === null ? "" : `, as of ${Math.round(r.as_of.age_s / 60)} min ago`;
    out.println(
        pc.bold(`${r.path}  ${humanBytes(r.node.alloc_bytes)}`) +
            pc.dim(`  (${r.node.files.toLocaleString()} files${age})`)
    );
    const rows = r.children.map((c) => [
        humanBytes(c.alloc_bytes),
        `${(c.share * 100).toFixed(1)}%`,
        c.files.toLocaleString(),
        c.flags ? `${c.name} ${pc.yellow(`[flags ${c.flags}]`)}` : c.name,
    ]);
    if (r.local.alloc_bytes > 0 || r.local.dirs > 0) {
        rows.push([
            humanBytes(r.local.alloc_bytes),
            `${r.node.alloc_bytes > 0 ? ((r.local.alloc_bytes / r.node.alloc_bytes) * 100).toFixed(1) : "0.0"}%`,
            r.local.files.toLocaleString(),
            pc.dim(`(files here plus ${r.local.dirs.toLocaleString()} small folders)`),
        ]);
    }

    out.println(formatTable(rows, ["SIZE", "SHARE", "FILES", "NAME"]));
    if (r.truncated) {
        out.println(pc.dim("(more children; raise --limit)"));
    }

    if (r.top_files.length > 0) {
        out.println(pc.bold("Largest files"));
        out.println(
            formatTable(
                r.top_files.map((f) => [
                    humanBytes(f.alloc_bytes),
                    f.path.startsWith(`${r.path}/`) ? f.path.slice(r.path.length + 1) : f.path,
                ]),
                ["SIZE", "PATH"]
            )
        );
    }
}

function renderLargest(r: QueryLargest): void {
    if (r.largest === "files") {
        out.println(
            formatTable(
                r.rows.map((f) => [humanBytes(f.alloc_bytes), f.path]),
                ["SIZE", "PATH"]
            )
        );
        return;
    }

    out.println(
        formatTable(
            r.rows.map((d) => [humanBytes(d.local_alloc_bytes), humanBytes(d.alloc_bytes), d.path]),
            ["HERE", "SUBTREE", "PATH"]
        )
    );
}

function renderInfo(r: QueryInfo): void {
    out.println(pc.bold(`${r.db}  (${humanBytes(r.db_bytes)})`));
    for (const [k, v] of Object.entries(r.meta)) {
        out.println(`  ${k.padEnd(22)} ${v}`);
    }

    out.println(
        `  rows: ${r.counts.dirs} dirs, ${r.counts.tombstones} tombstones, ${r.counts.big_files} big files, ` +
            `${r.counts.snapshots} snapshots, ${r.counts.dirty_queue} queued`
    );
    out.println(
        formatTable(
            r.scans.map((s) => [
                String(s.id),
                s.kind,
                s.status,
                new Date(s.started_at_ms).toLocaleString(),
                s.walk_ms === null ? "" : `${s.walk_ms} ms`,
                s.alloc_bytes === null ? "" : humanBytes(s.alloc_bytes),
            ]),
            ["SCAN", "KIND", "STATUS", "STARTED", "WALK", "ROOT SIZE"]
        )
    );
}

function renderDiff(r: DiffResult): void {
    const to = r.to.live ? "now" : `snapshot ${r.to.snapshot_id}`;
    const sign = r.total_delta.alloc_bytes >= 0 ? "+" : "-";
    out.println(
        pc.bold(
            `${r.root}: ${sign}${humanBytes(Math.abs(r.total_delta.alloc_bytes))} since ${new Date(r.from.taken_at_ms).toLocaleString()} (snapshot ${r.from.snapshot_id} to ${to})`
        )
    );
    out.println(
        formatTable(
            r.rows.map((row) => [
                `${row.delta >= 0 ? "+" : "-"}${humanBytes(Math.abs(row.delta))}${row.approx ? "~" : ""}`,
                row.status,
                row.path,
            ]),
            ["DELTA", "STATUS", "PATH"]
        )
    );
    out.println(pc.dim(`Only folders of at least ${humanBytes(r.floor)} are compared; ~ marks a lower bound.`));
}

function renderSchedule(s: ScheduleStatus): void {
    out.println(s.registered ? `${s.task}: ${s.every}\n  ${s.command}` : `${s.task}: not registered`);
}

interface CommonOpts {
    db?: string;
    format?: string;
}

function dbOption(): Option {
    return new Option("--db <path>", "Index database (default ~/.genesis-tools/du/index.db)");
}

function formatOption(): Option {
    return new Option("--format <fmt>", "Output: human on a terminal, json otherwise").choices([
        "human",
        "json",
        "ndjson",
    ]);
}

function stallOption(): Option {
    return new Option(
        "--stall-seconds <s>",
        "Give up a folder whose listing makes no progress this long (default 10; 0 = wait forever)"
    ).argParser(intOpt("--stall-seconds", { min: 0, max: 3600 }));
}

function minFreeOption(): Option {
    return new Option("--min-free-gb <n>", "Refuse to run below this much free space").hideHelp();
}

export function registerIndexCommands(program: Command): void {
    const index = program
        .command("index")
        .description("Persisted directory-size index (SQLite) behind the Disk Manager: build, update, query, diff");

    index
        .command("build")
        .description("Walk the root once and store every directory of at least --min-dir-bytes")
        .addOption(dbOption())
        .addOption(formatOption())
        .option("--root <path>", "Directory to index (default: $HOME)")
        .option("--threads <n>", "Walker threads (default min(8, CPUs))", intOpt("--threads", { min: 1, max: 256 }))
        .option(
            "--min-dir-bytes <n>",
            "Fold smaller subtrees into their parent (default 1 MiB)",
            intOpt("--min-dir-bytes", { min: 0 })
        )
        .option(
            "--big-file-floor <n>",
            "Record files of at least this size (default 8 MiB)",
            intOpt("--big-file-floor", { min: 1 })
        )
        .option(
            "--big-file-limit <n>",
            "Keep at most this many big files (default 50000)",
            intOpt("--big-file-limit", { min: 0 })
        )
        .option("--no-private", "Skip PRIVATESIZE (halves the kernel cost; no 'shared' figure)")
        .option("--exclude <path...>", "Do not walk these directories")
        .option("--include-cloud", "Also walk ~/Library/CloudStorage and iCloud Drive (may download placeholders)")
        .option("--no-snapshot", "Do not record a snapshot for diff")
        .option(
            "--snapshot-floor <n>",
            "Snapshot folders of at least this size (default 64 MiB)",
            intOpt("--snapshot-floor", { min: 0 })
        )
        .option("--reset", "Drop the existing rows first (needed to change the root of a database)")
        .option("--stop-on-stdin", "Cancel when stdin reaches EOF")
        .addOption(stallOption())
        .addOption(minFreeOption())
        .action(
            async (
                opts: CommonOpts & {
                    root?: string;
                    stallSeconds?: number;
                    threads?: number;
                    minDirBytes?: number;
                    bigFileFloor?: number;
                    bigFileLimit?: number;
                    private: boolean;
                    exclude?: string[];
                    includeCloud?: boolean;
                    snapshot: boolean;
                    snapshotFloor?: number;
                    reset?: boolean;
                    stopOnStdin?: boolean;
                    minFreeGb?: string;
                }
            ) => {
                const format = resolveFormat(opts.format);
                await run("build", format, () =>
                    withInterrupt(
                        async (interrupt) => {
                            const signal = stopOnStdin(opts.stopOnStdin, interrupt);
                            try {
                                const result = await buildIndex({
                                    db: opts.db ?? defaultDbPath(),
                                    root: opts.root ?? env.paths.getHome(),
                                    threads: opts.threads,
                                    minDirBytes: opts.minDirBytes,
                                    bigFileFloor: opts.bigFileFloor,
                                    bigFileLimit: opts.bigFileLimit,
                                    private: opts.private,
                                    excludes: (opts.exclude ?? []).map(absPath),
                                    includeCloud: opts.includeCloud,
                                    snapshot: opts.snapshot,
                                    snapshotFloor: opts.snapshotFloor,
                                    reset: opts.reset,
                                    stallSeconds: opts.stallSeconds,
                                    minFreeBytes:
                                        opts.minFreeGb === undefined ? undefined : Number(opts.minFreeGb) * GiB,
                                    signal,
                                    emit:
                                        format === "ndjson"
                                            ? (e) => {
                                                  if (e.type !== "result") {
                                                      printJson(e, format);
                                                  }
                                              }
                                            : format === "human"
                                              ? humanProgress()
                                              : undefined,
                                });
                                if (format === "human") {
                                    renderBuild(result);
                                } else {
                                    printJson(result, format);
                                }
                            } finally {
                                releaseStdin(opts.stopOnStdin);
                            }
                        },
                        { handleTermination: true }
                    )
                );
            }
        );

    index
        .command("update")
        .description("Re-walk only the regions that hold the given paths, then re-aggregate up to the root")
        .addOption(dbOption())
        .addOption(formatOption())
        .option("--root <path>", "Fail unless the index root is this directory")
        .option("--paths <path...>", "Changed paths (directories, or files with --shallow)")
        .option("--shallow", "The paths are entries: recheck their parent directory only")
        .option("--recursive", "Re-walk each path's whole subtree, stored folders included (FSEvents MustScanSubDirs)")
        .option("--from-queue", "Also consume the paths queued while a build held the lock")
        .option("--threads <n>", "Walker threads per region (default 4)", intOpt("--threads", { min: 1, max: 256 }))
        .option(
            "--lock-wait <ms>",
            "Wait this long for a running build before queueing (default 2000)",
            intOpt("--lock-wait", { min: 0 })
        )
        .option("--stop-on-stdin", "Cancel when stdin reaches EOF")
        .addOption(stallOption())
        .addOption(minFreeOption())
        .action(
            async (
                opts: CommonOpts & {
                    root?: string;
                    stallSeconds?: number;
                    paths?: string[];
                    shallow?: boolean;
                    recursive?: boolean;
                    fromQueue?: boolean;
                    threads?: number;
                    lockWait?: number;
                    stopOnStdin?: boolean;
                    minFreeGb?: string;
                }
            ) => {
                const format = resolveFormat(opts.format);
                await run("update", format, async () => {
                    if ((opts.paths ?? []).length === 0 && !opts.fromQueue) {
                        throw new IndexError(
                            "usage",
                            `Pass --paths <path...> or --from-queue (${toolCommand("du index update --help")}).`
                        );
                    }

                    await withInterrupt(
                        async (interrupt) => {
                            const signal = stopOnStdin(opts.stopOnStdin, interrupt);
                            try {
                                const result = await updateIndex({
                                    db: opts.db ?? defaultDbPath(),
                                    root: opts.root,
                                    paths: opts.paths ?? [],
                                    shallow: opts.shallow,
                                    recursive: opts.recursive,
                                    fromQueue: opts.fromQueue,
                                    threads: opts.threads,
                                    lockWaitMs: opts.lockWait,
                                    stallSeconds: opts.stallSeconds,
                                    minFreeBytes:
                                        opts.minFreeGb === undefined ? undefined : Number(opts.minFreeGb) * GiB,
                                    signal,
                                    emit: format === "ndjson" ? (e) => printJson(e, format) : undefined,
                                });
                                if (format === "human") {
                                    renderUpdate(result);
                                } else {
                                    printJson(result, format);
                                }
                            } finally {
                                releaseStdin(opts.stopOnStdin);
                            }
                        },
                        { handleTermination: true }
                    );
                });
            }
        );

    index
        .command("query")
        .description("One directory with its stored children and largest files, a global top list, or --info")
        .addOption(dbOption())
        .addOption(formatOption())
        .option("--path <path>", "Directory to show (default: the indexed root)")
        .option("--children", "Include the stored children (default)")
        .option("--no-children", "Leave the children out")
        .addOption(new Option("--sort <key>", "Child order").choices([...QUERY_SORTS]).default("alloc"))
        .option("--limit <n>", "At most this many rows (default 200, 50 for --largest)", intOpt("--limit", { min: 1 }))
        .option("--min-bytes <n>", "Only children of at least this size", intOpt("--min-bytes", { min: 0 }))
        .option(
            "--changed-within <dur>",
            "Only children holding a file modified within this window (24h, 7d)",
            durationToCutoff("--changed-within")
        )
        .option("--top-files <n>", "Largest files under the directory (default 10)", intOpt("--top-files", { min: 0 }))
        .addOption(
            new Option("--largest <kind>", "A global list instead: dirs (by own bytes) or files").choices([
                "dirs",
                "files",
            ])
        )
        .option("--info", "Metadata, row counts and recent scans")
        .action(
            async (
                opts: CommonOpts & {
                    path?: string;
                    children?: boolean;
                    sort: QuerySort;
                    limit?: number;
                    minBytes?: number;
                    changedWithin?: number;
                    topFiles?: number;
                    largest?: "dirs" | "files";
                    info?: boolean;
                }
            ) => {
                const format = resolveFormat(opts.format);
                const db = opts.db ?? defaultDbPath();
                await run("query", format, async () => {
                    if (opts.info) {
                        const info = queryInfo({ db });
                        if (format === "human") {
                            renderInfo(info);
                        } else {
                            printJson(info, format);
                        }
                        return;
                    }

                    if (opts.largest) {
                        const largest = queryLargest({ db, largest: opts.largest, limit: opts.limit });
                        if (format === "human") {
                            renderLargest(largest);
                        } else {
                            printJson(largest, format);
                        }
                        return;
                    }

                    const result = queryPath({
                        db,
                        path: opts.path ? absPath(opts.path) : undefined,
                        children: opts.children,
                        sort: opts.sort,
                        limit: opts.limit,
                        minBytes: opts.minBytes,
                        changedSince: opts.changedWithin,
                        topFiles: opts.topFiles,
                    });
                    if (format === "human") {
                        renderQuery(result);
                    } else {
                        printJson(result, format);
                    }
                });
            }
        );

    index
        .command("diff")
        .description("What grew and shrank between two snapshots, or since a snapshot")
        .addOption(dbOption())
        .addOption(formatOption())
        .option(
            "--from <when>",
            "Snapshot id, ISO date or duration back from now (7d). Default: the latest snapshot before --to"
        )
        .option("--to <when>", "Snapshot id or now (default now)")
        .option(
            "--min-delta <n>",
            "Only rows that moved by at least this many bytes",
            intOpt("--min-delta", { min: 0 })
        )
        .option("--limit <n>", "At most this many rows (default 200)", intOpt("--limit", { min: 1 }))
        .addOption(
            new Option("--attribute <mode>", "leaf drops a folder whose growth one subfolder already explains")
                .choices(["leaf", "all"])
                .default("leaf")
        )
        .action(
            async (
                opts: CommonOpts & {
                    from?: string;
                    to?: string;
                    minDelta?: number;
                    limit?: number;
                    attribute: "leaf" | "all";
                }
            ) => {
                const format = resolveFormat(opts.format);
                await run("diff", format, async () => {
                    const result = diffIndex({
                        db: opts.db ?? defaultDbPath(),
                        from: opts.from,
                        to: opts.to,
                        minDelta: opts.minDelta,
                        limit: opts.limit,
                        attribute: opts.attribute,
                    });
                    if (format === "human") {
                        renderDiff(result);
                    } else {
                        printJson(result, format);
                    }
                });
            }
        );

    index
        .command("schedule")
        .description(`Register or remove the nightly build with \`${toolCommand("daemon")}\` (02:15)`)
        .addOption(formatOption())
        .option("--on", "Register the nightly build")
        .option("--off", "Remove it")
        .option("--status", "Show the registration (default)")
        .action(async (opts: CommonOpts & { on?: boolean; off?: boolean; status?: boolean }) => {
            const format = resolveFormat(opts.format);
            await run("schedule", format, async () => {
                if (opts.on && opts.off) {
                    throw new IndexError("usage", "Pass --on or --off, not both.");
                }

                if (opts.on) {
                    await scheduleIndexTask();
                } else if (opts.off) {
                    await unscheduleIndexTask();
                }

                const status = await indexTaskStatus();
                if (format === "human") {
                    renderSchedule(status);
                } else {
                    printJson(status, format);
                }
            });
        });
}
