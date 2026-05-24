/**
 * Isolated WALK microbenchmark. Times JUST the directory walk
 * (readdirSync + statSync) with no hashing, no clone-id lookup, no caching.
 * Used to measure the impact of P1 (getattrlistbulk FFI) on the walk
 * phase of `tools macos clones duplicates`.
 *
 * Variants:
 *   - "readdir-only"     readdirSync recursive, NO per-file stat (lower bound)
 *   - "readdir-stat"     readdirSync + statSync per file (current walkFiles)
 *   - "getattrlistbulk"  P1 future variant (errors with "not implemented" until P1 lands)
 *
 * Usage:
 *   bun scripts/benchmarks/clones/microbenches/apfs-bench-walk-isolated.ts \
 *     --root ~/Tresors/Projects/GenesisTools --iterations 5 \
 *     [--variant readdir-stat] [--jsonl /tmp/walk-results.jsonl] [--label phase-0]
 *
 * Output: one summary line on stderr, one JSON object on stdout (and to
 * --jsonl if given). JSON shape:
 *   {variant, root, dirs, files, iterations, runsMs:[…], meanMs, medianMs, p95Ms, minMs, maxMs}
 */

import { type Dirent, appendFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

interface Args {
    root: string;
    iterations: number;
    variant: "readdir-only" | "readdir-stat" | "getattrlistbulk";
    jsonl: string | null;
    label: string;
}

function parseArgs(): Args {
    const argv = process.argv.slice(2);
    let root = "";
    let iterations = 4;
    let variant: Args["variant"] = "readdir-stat";
    let jsonl: string | null = null;
    let label = "";
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--root") {
            root = argv[++i] ?? "";
        } else if (a === "--iterations") {
            iterations = Number.parseInt(argv[++i] ?? "4", 10) || 4;
        } else if (a === "--variant") {
            variant = (argv[++i] as Args["variant"]) ?? "readdir-stat";
        } else if (a === "--jsonl") {
            jsonl = argv[++i] ?? null;
        } else if (a === "--label") {
            label = argv[++i] ?? "";
        }
    }
    if (!root) {
        console.error("usage: --root <dir> [--iterations 4] [--variant readdir-only|readdir-stat|getattrlistbulk] [--jsonl path] [--label name]");
        process.exit(2);
    }
    return { root, iterations, variant, jsonl, label };
}

function walkReaddirOnly(root: string): { dirs: number; files: number } {
    let dirs = 0;
    let files = 0;
    const stack = [root];
    while (stack.length > 0) {
        const cur = stack.pop() as string;
        let entries: Dirent[];
        try {
            entries = readdirSync(cur, { withFileTypes: true });
        } catch {
            continue;
        }

        dirs += 1;
        for (const e of entries) {
            if (e.isSymbolicLink()) {
                continue;
            }

            if (e.isDirectory()) {
                stack.push(join(cur, e.name));
            } else if (e.isFile()) {
                files += 1;
            }
        }
    }
    return { dirs, files };
}

function walkReaddirStat(root: string): { dirs: number; files: number } {
    let dirs = 0;
    let files = 0;
    const stack = [root];
    while (stack.length > 0) {
        const cur = stack.pop() as string;
        let entries: Dirent[];
        try {
            entries = readdirSync(cur, { withFileTypes: true });
        } catch {
            continue;
        }

        dirs += 1;
        for (const e of entries) {
            if (e.isSymbolicLink()) {
                continue;
            }

            const p = join(cur, e.name);
            if (e.isDirectory()) {
                stack.push(p);
            } else if (e.isFile()) {
                try {
                    statSync(p, { bigint: true });
                    files += 1;
                } catch {
                    // unreadable
                }
            }
        }
    }
    return { dirs, files };
}

async function walkGetattrlistbulk(root: string): Promise<{ dirs: number; files: number }> {
    const mod = await import("@app/utils/macos/getattrlistbulk");
    return mod.walkGetattrlistbulk(root);
}

function pickWalker(variant: Args["variant"]): (root: string) => Promise<{ dirs: number; files: number }> {
    if (variant === "readdir-only") {
        return async (r) => walkReaddirOnly(r);
    }

    if (variant === "readdir-stat") {
        return async (r) => walkReaddirStat(r);
    }

    return walkGetattrlistbulk;
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) {
        return 0;
    }

    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx] as number;
}

async function main(): Promise<void> {
    const args = parseArgs();
    const walker = pickWalker(args.variant);

    // Warm OS metadata cache by running the walker once before timing.
    // Walk benchmarks are dominated by getdents/stat syscalls which hit the
    // VFS dentry cache — cold runs measure I/O, warm runs measure syscall +
    // userspace overhead. For comparing variants the warm number is what
    // matters (you'll have just done a scan anyway).
    process.stderr.write(`[walk-bench] warmup variant=${args.variant} root=${args.root}\n`);
    const warm = await walker(args.root);
    process.stderr.write(`[walk-bench]   warm: ${warm.dirs} dirs, ${warm.files} files\n`);

    const runsMs: number[] = [];
    for (let i = 0; i < args.iterations; i++) {
        const t0 = performance.now();
        const r = await walker(args.root);
        const dt = performance.now() - t0;
        runsMs.push(dt);
        process.stderr.write(
            `[walk-bench]   run ${i + 1}/${args.iterations}: ${dt.toFixed(0)}ms (${r.dirs} dirs, ${r.files} files)\n`
        );
    }

    const sorted = [...runsMs].sort((a, b) => a - b);
    const mean = runsMs.reduce((s, x) => s + x, 0) / runsMs.length;
    const summary = {
        kind: "walk",
        variant: args.variant,
        root: args.root,
        label: args.label,
        dirs: warm.dirs,
        files: warm.files,
        iterations: args.iterations,
        runsMs: runsMs.map((x) => Math.round(x)),
        meanMs: Math.round(mean),
        medianMs: Math.round(percentile(sorted, 50)),
        p95Ms: Math.round(percentile(sorted, 95)),
        minMs: Math.round(sorted[0] ?? 0),
        maxMs: Math.round(sorted[sorted.length - 1] ?? 0),
        ts: new Date().toISOString(),
    };

    const json = JSON.stringify(summary);
    process.stdout.write(`${json}\n`);
    if (args.jsonl) {
        appendFileSync(args.jsonl, `${json}\n`);
    }
}

main().catch((err) => {
    process.stderr.write(`[walk-bench] ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
});
