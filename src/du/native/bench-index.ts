#!/usr/bin/env bun

// Benchmark for `tools du index`: the persisted index against the walks it replaces.
//
// Every sample is a fresh process under /usr/bin/time -l, so CPU time (user + system,
// children included) and peak RSS come from the kernel, not from a timer in the tool.
// Arms are interleaved: round r starts at arm r, so a load change during the run is
// spread over every arm instead of landing on one. The load average is recorded
// before every sample, and the free space of the Data volume before every round
// (the run stops under --min-free-gb).
//
// Usage:
//   bun src/du/native/bench-index.ts --rounds 5 --arms du,depth6,bigfiles \
//     --target a=/path/to/one-repo --target b=/path/to/another-repo \
//     --bin /tmp/clonesize --out /tmp/result.json
// Arms: du, depth6, bigfiles, index-c, index-c-noprivate, index-build, index-update.
// index-update re-walks one region: pass --update-path <target>=<abs dir>.
// A target's `.worktrees` folder is excluded in every arm that can exclude it.

import { existsSync, mkdirSync, statfsSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";

interface Sample {
    target: string;
    arm: string;
    round: number;
    wallS: number;
    userS: number;
    sysS: number;
    cpuS: number;
    maxRssMb: number;
    load1: number;
    exit: number;
    check: string;
}

interface Args {
    rounds: number;
    arms: string[];
    targets: Map<string, string>;
    bin: string;
    out: string | null;
    dbDir: string;
    updatePaths: Map<string, string>;
    minFreeGb: number;
    threads: number | null;
}

function parseArgs(argv: string[]): Args {
    const args: Args = {
        rounds: 5,
        arms: ["du", "depth6", "bigfiles"],
        targets: new Map(),
        bin: join(import.meta.dir, "clonesize"),
        out: null,
        dbDir: "/tmp",
        updatePaths: new Map(),
        minFreeGb: 6,
        threads: null,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = (): string => {
            const v = argv[++i];
            if (v === undefined) {
                throw new Error(`${a} needs a value`);
            }

            return v;
        };

        if (a === "--rounds") {
            args.rounds = Number.parseInt(next(), 10);
        } else if (a === "--arms") {
            args.arms = next().split(",");
        } else if (a === "--target" || a === "--update-path") {
            const v = next();
            const eq = v.indexOf("=");
            const map = a === "--target" ? args.targets : args.updatePaths;
            map.set(v.slice(0, eq), v.slice(eq + 1));
        } else if (a === "--bin") {
            args.bin = next();
        } else if (a === "--out") {
            args.out = next();
        } else if (a === "--db-dir") {
            args.dbDir = next();
        } else if (a === "--min-free-gb") {
            args.minFreeGb = Number(next());
        } else if (a === "--threads") {
            args.threads = Number.parseInt(next(), 10);
        } else {
            throw new Error(`unknown argument ${a}`);
        }
    }

    return args;
}

const DU_CLI = join(import.meta.dir, "..", "index.ts");

function command(args: Args, target: string, path: string, arm: string): string[] {
    const wt = join(path, ".worktrees");
    const exclude = existsSync(wt) ? ["--exclude", wt] : [];
    const threads = args.threads ? ["--threads", String(args.threads)] : [];
    const db = join(args.dbDir, `bench-${target}.db`);
    // The CLI arms get the run's own free-space floor (the CLI default is 8 GiB).
    const minFree = ["--min-free-gb", String(args.minFreeGb)];
    switch (arm) {
        case "du":
            return ["du", "-sk", "-I", ".worktrees", path];
        case "depth6":
            return [args.bin, "--format", "json", "--quiet", "--depth", "6", ...threads, ...exclude, path];
        case "bigfiles":
            return [args.bin, "--bigfiles", "--min-bytes", "8388608", "--prune-name", ".worktrees", ...threads, path];
        case "index-c":
            return [args.bin, "--index", ...threads, ...exclude, path];
        case "index-c-noprivate":
            return [args.bin, "--index", "--no-private", ...threads, ...exclude, path];
        case "index-build":
            return [
                "bun",
                DU_CLI,
                "index",
                "build",
                "--root",
                path,
                "--db",
                db,
                "--format",
                "json",
                ...minFree,
                ...threads,
                ...exclude,
            ];
        case "index-update": {
            const region = args.updatePaths.get(target);
            if (!region) {
                throw new Error(`index-update needs --update-path ${target}=<dir>`);
            }

            return [
                "bun",
                DU_CLI,
                "index",
                "update",
                "--root",
                path,
                "--db",
                db,
                "--format",
                "json",
                ...minFree,
                "--paths",
                region,
            ];
        }
        default:
            throw new Error(`unknown arm ${arm}`);
    }
}

/** A value that must agree across rounds of one arm (and across arms, where they
 *  measure the same thing), so a broken run cannot pass as a fast one. */
function checkValue(arm: string, stdout: string): string {
    if (arm === "du") {
        return stdout.split("\t")[0] ?? "";
    }

    if (arm === "depth6") {
        return String(SafeJSON.parse(stdout, { strict: true }).naive_bytes);
    }

    if (arm === "bigfiles") {
        const j = SafeJSON.parse(stdout, { strict: true });
        return `files=${j.files_listed} big=${j.files.length}`;
    }

    if (arm.startsWith("index-c")) {
        const first = stdout.slice(0, stdout.indexOf("\n"));
        const row = SafeJSON.parse(first, { strict: true });
        return `alloc=${row.a} files=${row.c}`;
    }

    const j = SafeJSON.parse(stdout, { strict: true });
    if (arm === "index-build") {
        return `alloc=${j.alloc_bytes} files=${j.files} stored=${j.stored_dirs}`;
    }

    return `regions=${j.regions?.length} scan=${j.scan_id === null ? "queued" : "ok"}`;
}

async function sample(args: Args, target: string, path: string, arm: string, round: number): Promise<Sample> {
    const argv = command(args, target, path, arm);
    const load1 = loadavg()[0];
    const proc = Bun.spawn(["/usr/bin/time", "-l", ...argv], {
        stdout: "pipe",
        stderr: "pipe",
        env: env.getProcessEnv(),
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exit = await proc.exited;
    const times = /([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys/.exec(stderr);
    const rss = /(\d+)\s+maximum resident set size/.exec(stderr);
    if (!times || !rss) {
        throw new Error(`no /usr/bin/time output for ${arm} on ${target}: ${stderr.slice(-400)}`);
    }

    let check = "";
    try {
        check = checkValue(arm, stdout);
    } catch (err) {
        check = `unparsed (${err instanceof Error ? err.message : String(err)})`;
    }

    const userS = Number(times[2]);
    const sysS = Number(times[3]);
    return {
        target,
        arm,
        round,
        wallS: Number(times[1]),
        userS,
        sysS,
        cpuS: userS + sysS,
        maxRssMb: Number(rss[1]) / 1024 / 1024,
        load1,
        exit,
        check,
    };
}

function freeGb(): number {
    const s = statfsSync("/System/Volumes/Data");
    return (s.bavail * s.bsize) / 1024 ** 3;
}

function stats(values: number[]): { min: number; median: number; max: number } {
    const v = [...values].sort((a, b) => a - b);
    const mid = Math.floor(v.length / 2);
    const median = v.length % 2 === 1 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
    return { min: v[0], median, max: v[v.length - 1] };
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    mkdirSync(args.dbDir, { recursive: true });
    const samples: Sample[] = [];
    const loadStart = loadavg();
    const targets = [...args.targets.entries()];
    for (let round = 0; round < args.rounds; round++) {
        const free = freeGb();
        if (free < args.minFreeGb) {
            out.println(`stopping: ${free.toFixed(1)} GiB free is under ${args.minFreeGb} GiB`);
            break;
        }

        for (const [target, path] of targets) {
            for (let k = 0; k < args.arms.length; k++) {
                const arm = args.arms[(round + k) % args.arms.length];
                const s = await sample(args, target, path, arm, round);
                samples.push(s);
                out.println(
                    `r${round} ${target.padEnd(4)} ${arm.padEnd(18)} wall ${s.wallS.toFixed(2)}s cpu ${s.cpuS.toFixed(2)}s ` +
                        `(user ${s.userS.toFixed(2)} sys ${s.sysS.toFixed(2)}) rss ${s.maxRssMb.toFixed(0)}MB ` +
                        `load ${s.load1.toFixed(1)} exit ${s.exit} ${s.check}`
                );
            }
        }
    }

    const loadEnd = loadavg();
    const summary: Record<string, unknown>[] = [];
    out.println("");
    out.println("target arm                n  wall med (min-max)      cpu med (min-max)       rss med   check");
    for (const [target] of targets) {
        for (const arm of args.arms) {
            const rows = samples.filter((s) => s.target === target && s.arm === arm);
            if (rows.length === 0) {
                continue;
            }

            const wall = stats(rows.map((r) => r.wallS));
            const cpu = stats(rows.map((r) => r.cpuS));
            const rss = stats(rows.map((r) => r.maxRssMb));
            const checks = [...new Set(rows.map((r) => r.check))];
            summary.push({ target, arm, n: rows.length, wall, cpu, rss, checks });
            out.println(
                `${target.padEnd(6)} ${arm.padEnd(18)} ${String(rows.length).padEnd(2)} ` +
                    `${wall.median.toFixed(2)} (${wall.min.toFixed(2)}-${wall.max.toFixed(2)})`.padEnd(24) +
                    `${cpu.median.toFixed(2)} (${cpu.min.toFixed(2)}-${cpu.max.toFixed(2)})`.padEnd(24) +
                    `${rss.median.toFixed(0)} MB`.padEnd(10) +
                    checks.join(" | ")
            );
        }
    }

    out.println(
        `load average start ${loadStart.map((l) => l.toFixed(2)).join(" ")}, end ${loadEnd.map((l) => l.toFixed(2)).join(" ")}`
    );
    const result = {
        at: new Date().toISOString(),
        loadStart,
        loadEnd,
        args: { ...args, targets, updatePaths: [...args.updatePaths] },
        summary,
        samples,
    };
    if (args.out) {
        writeFileSync(args.out, SafeJSON.stringify(result, null, 2));
    }
}

await main();
