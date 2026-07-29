import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { runTool } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage";
import { Command, Option } from "commander";
import pc from "picocolors";
import { scanWithBun } from "./lib/bun-scan";
import { readVolumeInfo, scanPartners, scanWithC, scanWithCFfi } from "./lib/engine";
import { diffScans, humanBytes, renderDiff, renderHuman, renderPartners, renderTree, renderVolume } from "./lib/format";
import { durationToCutoff, intOpt } from "./lib/options";
import type { ClonesizeResult, Engine, ScanOptions } from "./lib/types";
import { detectWorktreeExcludes } from "./lib/worktrees";

const program = new Command();
const storage = new Storage("du");

/**
 * Extent-cache directory. One file per volume lives here, keyed by fsid, so a
 * single cache serves every scan root on that volume (fileids are volume-wide).
 */
async function cacheDir(): Promise<string> {
    await storage.ensureDirs();
    return storage.getCacheDir();
}

program
    .name("tools du")
    .description(
        "Clone-aware disk usage for APFS. Measures the REAL on-disk footprint of trees\n" +
            "full of clonefiles (e.g. bun's clonefile(2) node_modules shared across git\n" +
            "worktrees), which plain `du` massively overcounts because every clone reports\n" +
            "its full size even though clones share physical blocks."
    )
    .version("0.1.0");

function assertDir(dir: string): string {
    const root = resolve(dir);
    let ok = false;
    try {
        ok = existsSync(root) && statSync(root).isDirectory();
    } catch {
        ok = false;
    }
    if (!ok) {
        out.error(`Not a directory: ${root}`);
        process.exit(1);
    }
    return root;
}

async function runScan(opts: ScanOptions, engine: Engine): Promise<{ result: ClonesizeResult; ms: number }> {
    const t0 = performance.now();
    let result: ClonesizeResult;
    if (engine === "bun") {
        result = await scanWithBun(opts);
    } else if (engine === "c") {
        result = scanWithC(opts);
    } else {
        result = scanWithCFfi(opts);
    }

    const ms = performance.now() - t0;
    return { result, ms };
}

// ---------------------------------------------------------------------------
// clonesize
// ---------------------------------------------------------------------------
program
    .command("clonesize")
    .description("Report naive (du-style) vs REAL unique on-disk bytes for a tree, deduping APFS clones")
    .argument("<dir>", "Directory to measure")
    .addOption(new Option("--format <fmt>", "Output format").choices(["human", "json"]).default("human"))
    .addOption(
        new Option("--engine <engine>", "Scan engine (c-ffi = C core via bun:ffi, default)")
            .choices(["c-ffi", "c", "bun"])
            .default("c-ffi")
    )
    .option("--threads <n>", "Worker threads (default: number of CPUs)", intOpt("--threads", { min: 1, max: 1024 }))
    .option("--freeable", "Also sum per-file ATTR_CMNEXT_PRIVATESIZE (C engine only)")
    .option("--min-bytes <n>", "Skip files whose allocated size < N bytes", intOpt("--min-bytes", { min: 0 }))
    .option("--depth <n>", "Per-directory tree down to depth N (du -d N style)", intOpt("--depth", { min: 0 }))
    .option("--freeable-tree", "Per-node ATTR_CMNEXT_PRIVATESIZE in the --depth tree (implies --depth 1)")
    .option("--ignore-worktrees", "Auto-detect and exclude git worktrees + .worktrees/ dirs")
    .option(
        "--changed-within <duration>",
        "Only count files modified within this window (7d, 24h, 30m) — 'what grew', not 'what is big'",
        durationToCutoff("--changed-within")
    )
    .option("--no-cache", "Ignore the extent cache when reading. It is still written, so the NEXT run is warm.")
    .option(
        "--include-cloud",
        "Also walk ~/Library/CloudStorage and iCloud Drive. Slow, and reading a placeholder can download it."
    )
    .option("--save <file>", "Write the raw JSON result to a file (pairs with --diff on a later run)")
    .option("--diff <file>", "Compare against a previously --saved scan and print the per-directory delta")
    .addHelpText(
        "after",
        [
            "",
            "Examples:",
            "  tools du clonesize .                          # this dir, pretty output",
            "  tools du clonesize ~/repo --ignore-worktrees  # skip sibling worktrees",
            "  tools du clonesize ~/repo --format json       # machine-readable",
            "  tools du clonesize ~/repo --engine bun        # independent Bun impl",
            "  tools du clonesize ~ --depth 1 --changed-within 7d   # what actually grew this week",
            "  tools du clonesize ~ --depth 2 --save mon.json       # ... then, days later:",
            "  tools du clonesize ~ --depth 2 --diff mon.json       # per-dir grown/shrunk/new/gone",
            "",
            "Repeat scans are served from an extent cache in ~/.genesis-tools/du/cache: a file",
            "whose (id, mtime, size, allocation) is unchanged cannot have moved blocks, so its",
            "extent map is reused instead of re-opened. On this repo that is ~3x faster.",
            "",
            "Point it at the PARENT of several worktrees to see how much they clone-share.",
            "Key truth: deleting a worktree frees only its *unique* blocks — blocks it",
            "shares with the main repo's node_modules stay. So du-reported worktree size",
            "is an upper bound, usually far above what is actually freed.",
        ].join("\n")
    )
    .action(
        async (
            dir: string,
            o: {
                format: "human" | "json";
                engine: Engine;
                threads?: number;
                freeable?: boolean;
                minBytes?: number;
                depth?: number;
                freeableTree?: boolean;
                ignoreWorktrees?: boolean;
                changedWithin?: number;
                cache: boolean;
                includeCloud?: boolean;
                save?: string;
                diff?: string;
            }
        ) => {
            const root = assertDir(dir);

            if (o.freeable && o.engine === "bun") {
                out.error("--freeable is only supported by the C engines (--engine c-ffi or c), not the Bun engine.");
                process.exit(2);
            }

            if ((o.depth !== undefined || o.freeableTree) && o.engine === "bun") {
                out.error(
                    "--depth / --freeable-tree are only supported by the C engines (--engine c-ffi or c). " +
                        "The Bun engine is the grand-total cross-check and does not build the per-dir tree."
                );
                process.exit(2);
            }

            if (o.changedWithin !== undefined && o.engine === "bun") {
                out.error("--changed-within is only supported by the C engines (--engine c-ffi or c).");
                process.exit(2);
            }

            // A diff is per-directory, so it needs the tree on both sides.
            const depth = (o.freeableTree || o.diff !== undefined) && o.depth === undefined ? 1 : o.depth;

            const exclude = o.ignoreWorktrees ? await detectWorktreeExcludes(root) : [];
            if (o.ignoreWorktrees && exclude.length > 0) {
                out.error(pc.dim(`Excluding ${exclude.length} worktree path(s):`));
                for (const e of exclude) {
                    out.error(pc.dim(`  - ${e}`));
                }
            }

            const scanOpts: ScanOptions = {
                path: root,
                threads: o.threads,
                freeable: o.freeable,
                minBytes: o.minBytes,
                depth,
                freeableTree: o.freeableTree,
                exclude,
                changedSince: o.changedWithin,
                cacheDir: o.engine === "bun" ? undefined : await cacheDir(),
                noCache: !o.cache,
                includeCloud: o.includeCloud,
            };

            const { result, ms } = await runScan(scanOpts, o.engine);

            if (o.save) {
                const savePath = resolve(o.save);
                await Bun.write(savePath, SafeJSON.stringify(result, null, 2));
                logger.debug({ savePath, nodes: result.nodes?.length ?? 0 }, "du: saved scan snapshot");
                out.log.success(`Saved scan to ${savePath}`);
            }

            if (o.diff) {
                const diffPath = resolve(o.diff);
                if (!existsSync(diffPath)) {
                    out.error(`No such snapshot: ${diffPath}`);
                    process.exit(1);
                }

                const before = SafeJSON.parse(await Bun.file(diffPath).text()) as ClonesizeResult;

                // Rows are matched on absolute node path, so a snapshot of another root
                // (or one saved without --depth) diffs to "everything is new", not to an
                // error. Both are meaningless numbers presented as a real delta.
                if (before.path !== result.path) {
                    out.error(
                        `${diffPath} is a scan of ${before.path}, not ${result.path}. A diff needs the same root on both sides.`
                    );
                    process.exit(2);
                }

                if (!before.nodes || before.nodes.length === 0) {
                    out.error(`${diffPath} has no per-directory tree. Re-save it with --depth N to diff against it.`);
                    process.exit(2);
                }

                const rows = diffScans(before, result);
                if (o.format === "json") {
                    out.result({ before: before.path, after: result.path, rows });
                } else {
                    out.println(renderDiff(before, result, rows));
                }
                return;
            }

            if (o.format === "json") {
                out.result({ ...result, engine: o.engine, elapsed_ms: Math.round(ms) });
            } else if (result.nodes && result.nodes.length > 0) {
                out.println(renderTree(result, o.engine, ms));
            } else {
                out.println(renderHuman(result, o.engine, ms));
            }
        }
    );

// ---------------------------------------------------------------------------
// volume
// ---------------------------------------------------------------------------
program
    .command("volume")
    .description("Reconcile a whole volume: APFS used-bytes vs what a scan can actually see")
    .argument("[mount]", "Volume mount point", "/System/Volumes/Data")
    .addOption(new Option("--format <fmt>", "Output format").choices(["human", "json"]).default("human"))
    .option("--threads <n>", "Worker threads (default: number of CPUs)", intOpt("--threads", { min: 1, max: 1024 }))
    .option("--depth <n>", "Also print a per-directory tree down to depth N", intOpt("--depth", { min: 0 }))
    .option("--include-cloud", "Also walk cloud-provider roots (slow; reading a placeholder can download it)")
    .addHelpText(
        "after",
        [
            "",
            "Answers 'my disk says 97% full — where is it?'. The scan is compared against",
            "ATTR_VOL_SPACEUSED, the same number diskutil prints as 'Volume Used Space',",
            "so anything the walk could not read shows up as an explicit UNACCOUNTED line",
            "instead of silently vanishing from the total.",
            "",
            "  tools du volume                       # the Data volume",
            "  sudo tools du volume                  # ... including root-only subtrees",
        ].join("\n")
    )
    .action(
        async (
            mount: string,
            o: { format: "human" | "json"; threads?: number; depth?: number; includeCloud?: boolean }
        ) => {
            const root = assertDir(mount);
            const vol = readVolumeInfo(root);
            logger.debug({ mount: root, used: vol.used_bytes }, "du: read volume attributes");

            out.log.info(`Scanning ${root} — a whole volume takes minutes, not seconds.`);
            const { result, ms } = await runScan(
                {
                    path: root,
                    threads: o.threads,
                    depth: o.depth,
                    cacheDir: await cacheDir(),
                    includeCloud: o.includeCloud,
                },
                "c-ffi"
            );

            if (o.format === "json") {
                const scanned = result.unique_allocated_bytes ?? result.unique_bytes;
                out.result({ volume: vol, scan: result, unaccounted_bytes: vol.used_bytes - scanned });
                return;
            }

            out.println(renderVolume(vol, result, ms));
            if (o.depth !== undefined && result.nodes && result.nodes.length > 0) {
                out.println("");
                out.println(renderTree(result, "c-ffi", ms));
            }
        }
    );

// ---------------------------------------------------------------------------
// clones
// ---------------------------------------------------------------------------
program
    .command("clones")
    .description("Find WHERE ELSE a directory's blocks live — the concrete clone partners")
    .argument("<dir>", "Directory whose shared blocks to trace")
    .option("--against <root>", "Where to search for partners (default: the dir's parent)")
    .addOption(new Option("--format <fmt>", "Output format").choices(["human", "json"]).default("human"))
    .option("--threads <n>", "Worker threads (default: number of CPUs)", intOpt("--threads", { min: 1, max: 1024 }))
    .option("--top <n>", "Rows to show (default 30)", intOpt("--top", { min: 1 }))
    .addHelpText(
        "after",
        [
            "",
            "`clonesize` tells you a dir shares N bytes with something. This tells you WITH WHAT.",
            "That is the question that decides whether a package-manager cache is safe to delete:",
            "blocks a live node_modules still references are not freed by deleting the cache.",
            "",
            "  tools du clones ~/.bun --against ~/Projects",
            "  tools du clones ~/repo/.worktrees/feat-x --against ~/repo",
        ].join("\n")
    )
    .action(async (dir: string, o: { against?: string; format: "human" | "json"; threads?: number; top?: number }) => {
        const target = assertDir(dir);
        const searchRoot = assertDir(o.against ?? resolve(target, ".."));

        // Not a prefix compare: /tmp/root is a prefix of the unrelated /tmp/root-other.
        const rel = relative(searchRoot, target);
        const contained = rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
        if (!contained) {
            out.error(`--against ${searchRoot} does not contain ${target}.`);
            process.exit(2);
        }

        const t0 = performance.now();
        const result = scanPartners({ target, root: searchRoot, threads: o.threads, top: o.top });
        const ms = performance.now() - t0;
        logger.debug({ target, searchRoot, partners: result.partner_files_total }, "du: partner scan complete");

        if (o.format === "json") {
            out.result({ ...result, elapsed_ms: Math.round(ms) });
            return;
        }

        out.println(renderPartners(result, ms));
    });

// ---------------------------------------------------------------------------
// bench
// ---------------------------------------------------------------------------
program
    .command("bench")
    .description("Benchmark the C engine vs the Bun engine vs plain `du -sh`, with a byte-for-byte cross-check")
    .argument("[dir]", "Directory to benchmark", ".")
    .option(
        "--threads <n>",
        "Worker threads for both engines (default: CPUs)",
        intOpt("--threads", { min: 1, max: 1024 })
    )
    .action(async (dir: string, o: { threads?: number }) => {
        const root = assertDir(dir);
        const scanOpts: ScanOptions = { path: root, threads: o.threads };

        out.println(pc.bold(`Benchmark — ${root}`));
        out.println(pc.dim("(warm the cache first; a cold first run is dominated by disk reads)"));
        out.println("");

        // du -sh
        out.println(pc.dim("running du -sh ..."));
        const duT0 = performance.now();
        let duSize = "?";
        try {
            duSize = execFileSync("du", ["-sh", root], { encoding: "utf-8", maxBuffer: 1 << 20 })
                .split("\t")[0]!
                .trim();
        } catch {
            duSize = "(failed)";
        }
        const duMs = performance.now() - duT0;

        // C engine via bun:ffi (the default/preferred native path)
        out.println(pc.dim("running C engine (bun:ffi) ..."));
        const cffi = await runScan(scanOpts, "c-ffi");

        // C engine as subprocess (reference)
        out.println(pc.dim("running C engine (subprocess) ..."));
        const c = await runScan(scanOpts, "c");

        // Bun engine (bun:ffi + Workers)
        out.println(pc.dim("running Bun engine (workers) ..."));
        const b = await runScan(scanOpts, "bun");

        // ---- cross-check: the two engines that matter (C-ffi vs Bun) ----
        const naiveMatch = cffi.result.naive_bytes === b.result.naive_bytes;
        const uniqueMatch = cffi.result.unique_bytes === b.result.unique_bytes;
        const match = naiveMatch && uniqueMatch;

        // ---- speed gap between engines (user wants a heads-up if C vs Bun > 20%) ----
        const gapPct = cffi.ms > 0 && b.ms > 0 ? (Math.abs(cffi.ms - b.ms) / Math.min(cffi.ms, b.ms)) * 100 : 0;

        out.println("");
        const rows = [
            {
                tool: "du -sh",
                ms: duMs,
                files: "-",
                size: duSize,
            },
            {
                tool: "clonesize (C ffi)",
                ms: cffi.ms,
                files: cffi.result.files_scanned,
                size: humanBytes(cffi.result.unique_bytes),
            },
            {
                tool: "clonesize (C proc)",
                ms: c.ms,
                files: c.result.files_scanned,
                size: humanBytes(c.result.unique_bytes),
            },
            {
                tool: "clonesize (Bun)",
                ms: b.ms,
                files: b.result.files_scanned,
                size: humanBytes(b.result.unique_bytes),
            },
        ];

        const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
        const padS = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s);

        out.println(pc.bold(`  ${pad("tool", 18)}${padS("wall", 10)}${padS("files/s", 12)}${padS("reported", 12)}`));
        for (const r of rows) {
            const fps =
                typeof r.files === "number" && r.ms > 0 ? Math.round((r.files / r.ms) * 1000).toLocaleString() : "-";
            out.println(
                `  ${pad(r.tool, 18)}${padS(`${(r.ms / 1000).toFixed(2)}s`, 10)}${padS(fps, 12)}${padS(r.size, 12)}`
            );
        }

        out.println("");
        const speedup = cffi.ms > 0 ? (b.ms / cffi.ms).toFixed(2) : "?";
        out.println(pc.dim(`  C (bun:ffi) is ${speedup}x faster than the Bun (workers) engine on wall time.`));
        const faster = cffi.ms <= b.ms ? "C (ffi)" : "Bun";
        const gapMsg = `  C-ffi vs Bun wall-time gap: ${gapPct.toFixed(0)}% (${faster} faster).`;
        out.println(gapPct > 20 ? pc.yellow(`${gapMsg} > 20% — worth a look.`) : pc.dim(gapMsg));
        out.println(
            pc.dim(
                `  naive: du-style ${humanBytes(cffi.result.naive_bytes)} → real unique ${humanBytes(
                    cffi.result.unique_bytes
                )} (${cffi.result.shared_pct.toFixed(1)}% shared).`
            )
        );

        out.println("");
        if (match) {
            out.println(pc.green(`  ✓ cross-check PASS — C (ffi) and Bun agree byte-for-byte`));
            out.println(pc.dim(`    naive=${cffi.result.naive_bytes}  unique=${cffi.result.unique_bytes}`));
        } else {
            out.println(pc.yellow(`  ⚠ cross-check DIFF (a live tree can change between runs):`));
            out.println(
                pc.dim(
                    `    naive  C=${cffi.result.naive_bytes} Bun=${b.result.naive_bytes} (${naiveMatch ? "match" : "differ"})`
                )
            );
            out.println(
                pc.dim(
                    `    unique C=${cffi.result.unique_bytes} Bun=${b.result.unique_bytes} (${uniqueMatch ? "match" : "differ"})`
                )
            );
            out.println(pc.dim(`    Re-run on a quiesced/static tree for an exact byte match.`));
        }
    });

await runTool(program, { tool: "du" });
