#!/usr/bin/env bun
/**
 * Coverage matrix for `tools du` and `tools macos clones`.
 *
 * Every case runs read-only against a deterministic fixture, so a baseline is
 * comparable across branches: it records wall/user/sys time and peak RSS for
 * speed, AND the normalized stdout for correctness. A refactor that keeps the
 * numbers identical and the output identical is safe; anything else shows up
 * in `--compare`.
 *
 *   bun scripts/benchmarks/clones/matrix.ts run --label before --fixture /tmp/fx
 *   bun scripts/benchmarks/clones/matrix.ts compare before after
 *   bun scripts/benchmarks/clones/matrix.ts list
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

const REPO = resolve(import.meta.dir, "../../..");
const TOOLS = join(REPO, "tools");
const BASELINES = join(REPO, "scripts/benchmarks/clones/baselines");

interface Case {
    id: string;
    group: "du" | "macos";
    /** argv after `tools`; `{T}` is replaced by the target, `{FX}` by the fixture root. */
    argv: string[];
    /** Which fixture subtree this case targets, for the report. */
    target: string;
    /** Whole-volume or otherwise minutes-long; opt in with --heavy, never in a default run. */
    heavy?: boolean;
}

function cases(): Case[] {
    const A = "{FX}/a-noclones";
    const B = "{FX}/b-realclones";
    const C = "{FX}/c-worktrees";
    const list: Case[] = [];
    const add = (id: string, group: Case["group"], target: string, argv: string[], heavy = false) =>
        list.push({ id, group, target, argv, heavy });

    // ---- tools du: clonesize, across engines / flags / shapes -----------------
    for (const engine of ["c-ffi", "c", "bun"]) {
        for (const [name, t] of [
            ["a", A],
            ["b", B],
            ["c", C],
        ] as const) {
            add(`du.clonesize.${engine}.${name}`, "du", t, [
                "du",
                "clonesize",
                t,
                "--engine",
                engine,
                "--no-cache",
                "--format",
                "json",
            ]);
        }
    }

    add("du.clonesize.freeable", "du", C, ["du", "clonesize", C, "--freeable", "--no-cache", "--format", "json"]);
    add("du.clonesize.depth1", "du", C, ["du", "clonesize", C, "--depth", "1", "--no-cache", "--format", "json"]);
    add("du.clonesize.depth2", "du", C, ["du", "clonesize", C, "--depth", "2", "--no-cache", "--format", "json"]);
    add("du.clonesize.freeable-tree", "du", C, [
        "du",
        "clonesize",
        C,
        "--freeable-tree",
        "--no-cache",
        "--format",
        "json",
    ]);
    add("du.clonesize.minbytes", "du", A, [
        "du",
        "clonesize",
        A,
        "--min-bytes",
        "4096",
        "--no-cache",
        "--format",
        "json",
    ]);
    add("du.clonesize.threads1", "du", C, ["du", "clonesize", C, "--threads", "1", "--no-cache", "--format", "json"]);
    add("du.clonesize.warmcache", "du", C, ["du", "clonesize", C, "--format", "json"]);
    add("du.clonesize.ignore-worktrees", "du", C, [
        "du",
        "clonesize",
        C,
        "--ignore-worktrees",
        "--no-cache",
        "--format",
        "json",
    ]);
    add("du.clonesize.changed-within", "du", C, [
        "du",
        "clonesize",
        C,
        "--changed-within",
        "24h",
        "--no-cache",
        "--format",
        "json",
    ]);
    add("du.clonesize.human", "du", B, ["du", "clonesize", B, "--no-cache"]);

    // partner scan (named `clones` before the merge, `partners` after)
    add("du.partners.b", "du", B, ["du", PARTNERS_VERB, `${B}`, "--against", "{FX}", "--format", "json"]);
    add("du.partners.c", "du", C, ["du", PARTNERS_VERB, `${C}/wt1`, "--against", C, "--format", "json"]);

    // Whole-volume walk: ~10 min per repeat on a 1 TB disk, and it starves every
    // other case of I/O. Opt in with --heavy when you specifically want it.
    add("du.volume", "du", "/", ["du", "volume", "--format", "json"], true);

    // ---- tools macos clones: read-only verbs ---------------------------------
    add("macos.measure.c", "macos", C, ["macos", "clones", "measure", C, "--min-real", "1", "--format", "json"]);
    add("macos.measure.nobreakdown", "macos", C, [
        "macos",
        "clones",
        "measure",
        C,
        "--min-real",
        "1",
        "--no-breakdown",
        "--format",
        "json",
    ]);
    add("macos.measure.b", "macos", B, ["macos", "clones", "measure", B, "--min-real", "1", "--format", "json"]);
    add("macos.measure.a", "macos", A, ["macos", "clones", "measure", A, "--min-real", "1", "--format", "json"]);
    add("macos.measure.sort-real", "macos", C, [
        "macos",
        "clones",
        "measure",
        C,
        "--min-real",
        "1",
        "--sort",
        "real",
        "--format",
        "json",
    ]);
    add("macos.measure.exclude", "macos", C, [
        "macos",
        "clones",
        "measure",
        C,
        "--min-real",
        "1",
        "--exclude",
        "**/wt1/**",
        "--format",
        "json",
    ]);
    add("macos.du.depth1", "macos", C, [
        "macos",
        "clones",
        "du",
        C,
        "--min-real",
        "1",
        "--depth",
        "1",
        "--format",
        "json",
    ]);
    add("macos.du.depth2", "macos", C, [
        "macos",
        "clones",
        "du",
        C,
        "--min-real",
        "1",
        "--depth",
        "2",
        "--format",
        "json",
    ]);
    add("macos.duplicates.c", "macos", C, ["macos", "clones", "duplicates", C, "--min-real", "1", "--format", "json"]);
    add("macos.duplicates.group", "macos", C, [
        "macos",
        "clones",
        "duplicates",
        C,
        "--min-real",
        "1",
        "--group",
        "--format",
        "json",
    ]);
    add("macos.duplicates.prefix-hash", "macos", C, [
        "macos",
        "clones",
        "duplicates",
        C,
        "--min-real",
        "1",
        "--prefix-hash",
        "--format",
        "json",
    ]);
    add("macos.optimize.dryrun", "macos", C, [
        "macos",
        "clones",
        "optimize",
        C,
        "--min-real",
        "1",
        "--no-cache",
        "--format",
        "json",
    ]);
    add("macos.optimize.nodemodules", "macos", C, [
        "macos",
        "clones",
        "optimize",
        `${C}/wt1`,
        "--node-modules",
        "--min-real",
        "1",
        "--no-cache",
        "--format",
        "json",
    ]);
    add("macos.reclaim.plan", "macos", C, [
        "macos",
        "clones",
        "reclaim",
        "plan",
        "--dir",
        C,
        "--min-real",
        "1",
        "--no-daemon",
        "--format",
        "json",
    ]);
    add("macos.reclaim.plan.targets", "macos", C, [
        "macos",
        "clones",
        "reclaim",
        "plan",
        "--dir",
        C,
        "--targets",
        "node_modules",
        "--min-real",
        "1",
        "--no-daemon",
        "--format",
        "json",
    ]);
    add("macos.reclaim.presets.list", "macos", "-", ["macos", "clones", "reclaim", "presets", "list"]);
    add("macos.config.list", "macos", "-", ["macos", "clones", "config", "--list"]);

    return list;
}

/** Renamed by the merge; kept in one place so a baseline taken before the rename still replays. */
const PARTNERS_VERB = process.env.GT_BENCH_PARTNERS_VERB ?? "partners";

interface Sample {
    wallMs: number;
    userMs: number;
    sysMs: number;
    maxRssBytes: number;
    exitCode: number;
}

interface CaseResult extends Case {
    resolvedArgv: string[];
    samples: Sample[];
    wall: { min: number; median: number; max: number };
    userMs: number;
    sysMs: number;
    maxRssBytes: number;
    exitCode: number;
    outputFile: string | null;
    outputBytes: number;
    stderrTail: string;
}

const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Run once under /usr/bin/time -l; stdout to a file, time block parsed off the tail of stderr. */
function runOnce(argv: string[], outFile: string, errFile: string): Sample {
    const t0 = performance.now();
    const r = spawnSync(
        "/bin/sh",
        ["-c", `/usr/bin/time -l "$@" > "${outFile}" 2> "${errFile}"`, "sh", TOOLS, ...argv],
        { encoding: "utf8" }
    );
    const wallMs = performance.now() - t0;
    const err = existsSync(errFile) ? readFileSync(errFile, "utf8") : "";
    const timeLine = /([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys/.exec(err);
    const rssLine = /(\d+)\s+maximum resident set size/.exec(err);
    return {
        wallMs,
        userMs: timeLine ? Number(timeLine[2]) * 1000 : Number.NaN,
        sysMs: timeLine ? Number(timeLine[3]) * 1000 : Number.NaN,
        maxRssBytes: rssLine ? Number(rssLine[1]) : Number.NaN,
        exitCode: r.status ?? -1,
    };
}

/** Strip everything that legitimately varies run to run, so outputs are diffable. */
function normalize(text: string, fixture: string): string {
    let s = text
        .replaceAll(fixture, "{FX}")
        .replaceAll(REPO, "{REPO}")
        .replaceAll(process.env.HOME ?? "~", "{HOME}");
    const volatileKeys = [
        "elapsed_ms",
        "changed_since",
        "free",
        "available",
        "freeSpaceTotal",
        "elapsedMs",
        "totalMs",
        "ms",
        "walkMs",
        "hashMs",
        "loadMs",
        "scanMs",
        "durationMs",
        "startedAt",
        "finishedAt",
        "timestamp",
        "ts",
        "id",
        "runId",
        "processId",
        "generatedAt",
        "mtime",
        "mtimeNs",
        "threads",
        "fileid",
        "fileId",
        "inode",
        "cloneId",
        "devoffset",
    ];
    for (const k of volatileKeys) {
        s = s.replaceAll(new RegExp(`("${k}"\\s*:\\s*)(-?[\\d.]+|"[^"]*")`, "g"), `$1"<volatile>"`);
    }
    // human output: timings and thread counts
    s = s.replace(/\b\d+\.\d{2}s\b/g, "<t>s").replace(/\b\d+ threads\b/g, "<n> threads");
    s = s.replace(/\b\d{4}-\d{2}-\d{2}T[\d:.-]+Z?\b/g, "<iso>");
    return s;
}

function cmdRun(label: string, fixture: string, repeat: number, only: string | null, withHeavy: boolean): void {
    const dir = join(BASELINES, label);
    const outDir = join(dir, "outputs");
    mkdirSync(outDir, { recursive: true });

    const all = cases()
        .filter((c) => (only ? c.id.includes(only) : true))
        .filter((c) => (withHeavy ? true : !c.heavy));
    console.log(`matrix: ${all.length} cases × ${repeat} repeats → ${dir}`);

    const results: CaseResult[] = [];
    // One untimed warmup pass. The tools persist a file-meta/extent cache under
    // $HOME, so a baseline taken right after a fresh checkout runs cold and one
    // taken later runs warm — a 30% "speedup" that is really just cache state.
    // Measuring only warm runs makes two baselines comparable.
    for (const c of all) {
        const argv = c.argv.map((a) => a.replaceAll("{FX}", fixture));
        runOnce(argv, join(dir, ".warmup.out"), join(dir, ".warmup.err"));
    }

    // Interleave repeats across cases so machine load spreads evenly, not per-case.
    const samples = new Map<string, Sample[]>();
    for (let pass = 0; pass < repeat; pass++) {
        for (const c of all) {
            const argv = c.argv.map((a) => a.replaceAll("{FX}", fixture));
            const out = join(outDir, `${c.id}.out`);
            const errf = join(dir, ".stderr.tmp");
            const s = runOnce(argv, out, errf);
            if (!samples.has(c.id)) {
                samples.set(c.id, []);
            }

            samples.get(c.id)!.push(s);
            if (pass === 0) {
                process.stdout.write(`  ${s.exitCode === 0 ? "ok  " : `EXIT${s.exitCode}`} ${c.id}\n`);
            }
        }
    }

    for (const c of all) {
        const argv = c.argv.map((a) => a.replaceAll("{FX}", fixture));
        const ss = samples.get(c.id)!;
        const out = join(outDir, `${c.id}.out`);
        const errf = join(dir, ".stderr.tmp");
        const raw = existsSync(out) ? readFileSync(out, "utf8") : "";
        const norm = normalize(raw, fixture);
        writeFileSync(out, norm);
        const walls = ss.map((s) => s.wallMs);
        results.push({
            ...c,
            resolvedArgv: argv,
            samples: ss,
            wall: { min: Math.min(...walls), median: median(walls), max: Math.max(...walls) },
            userMs: median(ss.map((s) => s.userMs)),
            sysMs: median(ss.map((s) => s.sysMs)),
            maxRssBytes: median(ss.map((s) => s.maxRssBytes)),
            exitCode: ss[0]!.exitCode,
            outputFile: `outputs/${c.id}.out`,
            outputBytes: norm.length,
            stderrTail: existsSync(errf)
                ? readFileSync(errf, "utf8").split("\n").slice(-3).join(" | ").slice(0, 200)
                : "",
        });
    }

    const meta = {
        label,
        takenAt: new Date().toISOString(),
        repeat,
        fixture,
        partnersVerb: PARTNERS_VERB,
        commit: execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        branch: execFileSync("git", ["-C", REPO, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(),
        dirty: execFileSync("git", ["-C", REPO, "status", "--short"], { encoding: "utf8" }).trim().length > 0,
        platform: `${process.platform}-${process.arch}`,
        cases: results.length,
    };
    writeFileSync(join(dir, "meta.json"), `${SafeJSON.stringify(meta, null, 2)}\n`);
    writeFileSync(join(dir, "results.json"), `${SafeJSON.stringify(results, null, 2)}\n`);

    const failed = results.filter((r) => r.exitCode !== 0);
    console.log(
        `\n${"case".padEnd(34)} ${"wall ms".padStart(9)} ${"cpu ms".padStart(8)} ${"maxRSS".padStart(9)}  exit`
    );
    for (const r of results) {
        const rss = Number.isNaN(r.maxRssBytes) ? "?" : `${(r.maxRssBytes / 1024 / 1024).toFixed(0)}M`;
        const cpu = Number.isNaN(r.userMs) ? "?" : `${(r.userMs + r.sysMs).toFixed(0)}`;
        console.log(
            `${r.id.padEnd(34)} ${r.wall.median.toFixed(0).padStart(9)} ${cpu.padStart(8)} ${rss.padStart(9)}  ${r.exitCode}`
        );
    }

    console.log(`\nbaseline written: ${dir}`);
    if (failed.length) {
        console.log(`NON-ZERO EXIT: ${failed.map((f) => `${f.id}(${f.exitCode})`).join(", ")}`);
    }
}

function cmdCompare(a: string, b: string): void {
    const load = (l: string) =>
        SafeJSON.parse(readFileSync(join(BASELINES, l, "results.json"), "utf8")) as CaseResult[];
    const ra = load(a);
    const rb = load(b);
    const byId = new Map(ra.map((r) => [r.id, r]));
    const readOut = (l: string, f: string | null) => {
        if (!f) {
            return null;
        }

        const p = join(BASELINES, l, f);
        return existsSync(p) ? readFileSync(p, "utf8") : null;
    };

    console.log(`compare ${a} → ${b}\n`);
    console.log(`${"case".padEnd(34)} ${"wall".padStart(14)} ${"cpu".padStart(13)} ${"rss".padStart(12)}  output`);
    let changed = 0;
    let gone = 0;
    for (const r of rb) {
        const o = byId.get(r.id);
        if (!o) {
            console.log(`${r.id.padEnd(34)} ${"NEW".padStart(14)}`);
            continue;
        }

        byId.delete(r.id);
        const pct = (x: number, y: number) => (x === 0 ? "?" : `${(((y - x) / x) * 100).toFixed(0)}%`);
        const oa = readOut(a, o.outputFile);
        const ob = readOut(b, r.outputFile);
        // A parallel walk can emit sibling directories in a different order run to
        // run. The depth tree carries parent INDICES, so sorting it would corrupt
        // the references — instead say plainly when two outputs hold the same
        // content in a different order, which is noise, not a behaviour change.
        const verdict = ((): "same" | "order" | "DIFF" => {
            if (oa === ob) {
                return "same";
            }

            if (oa === null || ob === null) {
                return "DIFF";
            }

            const bag = (t: string) => t.split(",").sort().join("\n");
            return bag(oa) === bag(ob) ? "order" : "DIFF";
        })();
        if (verdict === "DIFF") {
            changed++;
        }

        const cpuO = o.userMs + o.sysMs;
        const cpuN = r.userMs + r.sysMs;
        console.log(
            `${r.id.padEnd(34)} ${`${o.wall.median.toFixed(0)}→${r.wall.median.toFixed(0)} ${pct(o.wall.median, r.wall.median)}`.padStart(14)} ${`${cpuO.toFixed(0)}→${cpuN.toFixed(0)} ${pct(cpuO, cpuN)}`.padStart(13)} ${`${(o.maxRssBytes / 1048576).toFixed(0)}→${(r.maxRssBytes / 1048576).toFixed(0)}M`.padStart(12)}  ${verdict}${o.exitCode !== r.exitCode ? ` exit ${o.exitCode}→${r.exitCode}` : ""}`
        );
    }

    for (const [id] of byId) {
        console.log(`${id.padEnd(34)} ${"REMOVED".padStart(14)}`);
        gone++;
    }

    console.log(
        `\n${changed} case(s) changed output, ${gone} removed. ("order" = same content, different emission order.)`
    );
    if (changed) {
        console.log(
            `diff one with:\n  diff ${join(BASELINES, a, "outputs")}/<id>.out ${join(BASELINES, b, "outputs")}/<id>.out`
        );
    }
}

const [verb, ...rest] = process.argv.slice(2);
const flag = (name: string, def?: string): string | undefined => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : def;
};

if (verb === "run") {
    const label = flag("label");
    const fixture = flag("fixture");
    if (!label || !fixture) {
        console.error("usage: matrix.ts run --label <name> --fixture <dir> [--repeat 3] [--case <substr>] [--heavy]");
        process.exit(2);
    }

    cmdRun(label, resolve(fixture), Number(flag("repeat", "3")), flag("case") ?? null, rest.includes("--heavy"));
} else if (verb === "compare") {
    if (rest.length < 2) {
        console.error("usage: matrix.ts compare <labelA> <labelB>");
        process.exit(2);
    }

    cmdCompare(rest[0]!, rest[1]!);
} else if (verb === "renormalize") {
    // Re-apply the current masking to stored outputs. Use after widening
    // `volatileKeys`, so an old baseline stays comparable without a re-run.
    for (const label of rest) {
        const dir = join(BASELINES, label, "outputs");
        const meta = SafeJSON.parse(readFileSync(join(BASELINES, label, "meta.json"), "utf8")) as { fixture: string };
        let n = 0;
        for (const f of readdirSync(dir)) {
            const p2 = join(dir, f);
            const before = readFileSync(p2, "utf8");
            const after = normalize(before, meta.fixture);
            if (after !== before) {
                writeFileSync(p2, after);
                n++;
            }
        }

        console.log(`${label}: ${n} file(s) re-normalized`);
    }
} else if (verb === "list") {
    for (const c of cases()) {
        console.log(`${c.group.padEnd(6)} ${c.id.padEnd(34)} tools ${c.argv.join(" ")}`);
    }
} else {
    console.error("usage: matrix.ts run|compare|list");
    process.exit(2);
}
