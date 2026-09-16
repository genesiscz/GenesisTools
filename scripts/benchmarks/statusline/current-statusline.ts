/**
 * Baseline for the Claude Code statusline as it runs today, so a replacement can
 * be argued with rather than asserted.
 *
 * WHAT IS MEASURED. One full render of `~/.claude/helpers/statusline-graft.sh`,
 * which is what `~/.claude/settings.json` wires to `statusLine.command`. That is
 * the graft wrapper, the `node` shim it spawns in any checkout carrying a graft
 * graph, and `~/.claude/statusline.sh` underneath it: roughly fifteen `jq`
 * calls, two `tail | jq` passes over a real transcript, two `git` calls of which
 * one is `status --porcelain | wc -l`, a `ps` ancestor walk, and a
 * `tools claude info` spawn that starts a whole Bun process. The command under
 * test is a parameter (`--command`), so the same payloads, the same repos and
 * the same statistics measure a replacement such as
 * `tools ai statusline run --claude` without editing this file.
 *
 * WHY FOUR REPOS. Every segment except the git one costs the same everywhere.
 * `git status --porcelain` does not: it walks the work tree, so a large monorepo
 * pays far more than a small notes vault. Measuring one repo would hide the
 * spread that a cache is supposed to remove.
 *
 * WHY INTERLEAVED ROUNDS. `--runs 100` is split into `--rounds` batches and the
 * repos are cycled round-robin, so a load spike lands on every arm instead of
 * turning into "the client repo is slow". The per-round raw `times` arrays are merged and
 * the statistics are computed here rather than taken from any single hyperfine
 * summary. This is convention 5 in `scripts/benchmarks/README.md`.
 *
 * WHY AN IDLE TRANSCRIPT. The payload needs a real `transcript_path` or the two
 * `tail | jq` arms read nothing and the benchmark flatters itself. It must not
 * be a LIVE session's transcript: `statusline.sh` appends `epoch,tokens` to
 * `~/.claude/statusline/statusline.<session_id>.state` on every render, so four
 * hundred renders against a running session would corrupt the token delta that
 * session displays next. The default is therefore the newest transcript that
 * nothing has written to for `IDLE_MINUTES`; `--transcript` overrides it.
 *
 * WHAT THE SPAWN COUNT COUNTS. The render is bash, so the in-process
 * `withSpawnCounter` from `@app/benchmark/lib` cannot see it. Instead one
 * un-timed render per repo runs with counting wrappers prepended to PATH: each
 * wrapper appends its own name to a file and then `exec`s the real binary. The
 * tally is the number of external binary invocations the render performs, which
 * is one process each in the normal unshimmed case. Binaries outside
 * SHIMMED_BINARIES are invisible to it, so the number is a floor rather than an
 * exact total. Read `writeShims` before changing any of it: the wrappers live
 * one per directory for a reason that cost this machine a fork bomb to learn.
 */
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, loadavg } from "node:os";
import { join } from "node:path";
import { type BaselineMetrics, compareToBaseline, formatComparison, recordBaseline } from "@app/benchmark/lib";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { stripAnsi } from "@genesiscz/utils/string";
import { createBoxTable, renderCliHeader, renderCliSection } from "@genesiscz/utils/table";

const { log } = logger.scoped("bench-statusline");

const BASELINE_NAME = "statusline-current";
const WORK_DIR = join("/tmp", "statusline-bench");
const SAMPLES_DIR = join(import.meta.dir, "samples");
const DEFAULT_COMMAND = `bash ${join(homedir(), ".claude", "helpers", "statusline-graft.sh")}`;

function defaultTranscriptDir(): string {
    const claudeDir = env.paths.getClaudeConfigDir() ?? join(homedir(), ".claude");

    return join(claudeDir, "projects", process.cwd().replace(/\//g, "-"));
}

/** A transcript untouched for this long belongs to a session that is not rendering a statusline. */
const IDLE_MINUTES = 30;

/**
 * Wrappers are written for these names only. The list covers every external
 * binary either script is known to call; anything else the render spawns is
 * missing from the tally, which is why the metric is documented as a floor.
 */
const SHIMMED_BINARIES = [
    "awk",
    "basename",
    "bun",
    "cat",
    "curl",
    "cut",
    "date",
    "git",
    "grep",
    "head",
    "jq",
    "mkdir",
    "node",
    "npm",
    "ps",
    "sed",
    "tail",
    "tools",
    "tput",
    "tr",
    "wc",
] as const;

interface RepoTarget {
    /** Short label used in metric keys, table rows and sample file names. */
    name: string;
    path: string;
}

/**
 * This checkout plus whatever `STATUSLINE_BENCH_REPOS` names as `name=path,name=path`.
 * Extra arms (a large client checkout, a notes vault) stay out of git.
 */
function extraReposFromEnv(): RepoTarget[] {
    const raw = env.getProcessEnv().STATUSLINE_BENCH_REPOS ?? "";

    return raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.includes("="))
        .map((entry) => {
            const at = entry.indexOf("=");
            return { name: entry.slice(0, at).trim(), path: entry.slice(at + 1).trim() };
        });
}

const DEFAULT_REPOS: RepoTarget[] = [{ name: "GenesisTools", path: process.cwd() }, ...extraReposFromEnv()];

interface TranscriptChoice {
    path: string;
    sessionId: string;
    bytes: number;
    idleMinutes: number;
    /** False when no idle transcript existed and the newest one was taken anyway. */
    idle: boolean;
}

interface TimingStats {
    meanMs: number;
    medianMs: number;
    minMs: number;
    maxMs: number;
    userMs: number;
    systemMs: number;
    samples: number;
}

interface SpawnTally {
    total: number;
    byBinary: Record<string, number>;
}

interface RepoResult {
    repo: RepoTarget;
    timing: TimingStats;
    spawns: SpawnTally;
    /** ANSI stripped and the account name redacted; this is what lands in samples/. */
    sample: string;
    samplePath: string;
}

interface Args {
    baseline: boolean;
    baselineName: string;
    compare: boolean;
    json: boolean;
    runs: number;
    rounds: number;
    warmup: number;
    command: string;
    transcript: string | null;
    repos: RepoTarget[];
}

function hasFlag(argv: string[], flag: string): boolean {
    return argv.includes(flag);
}

function stringFlag(argv: string[], flag: string, fallback: string | null): string | null {
    const index = argv.indexOf(flag);

    if (index < 0 || index + 1 >= argv.length) {
        return fallback;
    }

    const value = argv[index + 1];

    if (value === undefined || value.startsWith("--")) {
        return fallback;
    }

    return value;
}

function numberFlag(argv: string[], flag: string, fallback: number): number {
    const raw = stringFlag(argv, flag, null);

    if (raw === null) {
        return fallback;
    }

    const parsed = Number.parseInt(raw, 10);

    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${flag} needs a positive integer, got "${raw}".`);
    }

    return parsed;
}

/**
 * `--repos` takes a comma-separated list. An entry matching a default repo's
 * NAME filters the set down to it (`--repos GenesisTools`), which is how a smoke
 * run stays on one arm; anything containing a slash is treated as a path and
 * measures a repo the default list does not carry.
 */
function parseRepos(argv: string[]): RepoTarget[] {
    const raw = stringFlag(argv, "--repos", null);

    if (raw === null) {
        return DEFAULT_REPOS;
    }

    return raw.split(",").map((entry) => {
        const value = entry.trim();
        const known = DEFAULT_REPOS.find((repo) => repo.name === value);

        if (known !== undefined) {
            return known;
        }

        const name = value.split("/").filter(Boolean).at(-1) ?? value;
        return { name, path: value };
    });
}

function parseArgs(argv: string[]): Args {
    return {
        baseline: hasFlag(argv, "--baseline"),
        baselineName: stringFlag(argv, "--baseline", BASELINE_NAME) ?? BASELINE_NAME,
        compare: hasFlag(argv, "--compare"),
        json: hasFlag(argv, "--json"),
        runs: numberFlag(argv, "--runs", 100),
        rounds: numberFlag(argv, "--rounds", 4),
        warmup: numberFlag(argv, "--warmup", 3),
        command: stringFlag(argv, "--command", DEFAULT_COMMAND) ?? DEFAULT_COMMAND,
        transcript: stringFlag(argv, "--transcript", null),
        repos: parseRepos(argv),
    };
}

function existingRepos(repos: RepoTarget[]): { present: RepoTarget[]; missing: RepoTarget[] } {
    const present: RepoTarget[] = [];
    const missing: RepoTarget[] = [];

    for (const repo of repos) {
        try {
            if (statSync(repo.path).isDirectory()) {
                present.push(repo);
                continue;
            }

            missing.push(repo);
        } catch (err) {
            log.debug({ err, path: repo.path }, "repo target is not reachable");
            missing.push(repo);
        }
    }

    return { present, missing };
}

/**
 * The newest transcript nothing has written to for IDLE_MINUTES, so four hundred
 * renders cannot disturb a session that is still displaying a statusline.
 */
function pickTranscript(explicit: string | null): TranscriptChoice {
    const now = Date.now();

    if (explicit !== null) {
        const stat = statSync(explicit);
        const sessionId =
            explicit
                .split("/")
                .at(-1)
                ?.replace(/\.jsonl$/, "") ?? "statusline-bench";
        const idleMinutes = (now - stat.mtimeMs) / 60_000;
        return { path: explicit, sessionId, bytes: stat.size, idleMinutes, idle: idleMinutes >= IDLE_MINUTES };
    }

    const transcriptDir = defaultTranscriptDir();
    let names: string[] = [];

    try {
        names = readdirSync(transcriptDir);
    } catch (err) {
        log.debug({ err, transcriptDir }, "transcript dir is not readable");
        throw new Error(`No transcripts under ${transcriptDir}; pass --transcript <path>.`);
    }

    const candidates = names
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => {
            const path = join(transcriptDir, name);
            const stat = statSync(path);
            return { path, sessionId: name.replace(/\.jsonl$/, ""), bytes: stat.size, mtimeMs: stat.mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

    if (candidates.length === 0) {
        throw new Error(`No transcripts under ${transcriptDir}; pass --transcript <path>.`);
    }

    const idle = candidates.find((entry) => now - entry.mtimeMs >= IDLE_MINUTES * 60_000);
    const chosen = idle ?? candidates[0];

    if (chosen === undefined) {
        throw new Error(`No transcripts under ${transcriptDir}; pass --transcript <path>.`);
    }

    return {
        path: chosen.path,
        sessionId: chosen.sessionId,
        bytes: chosen.bytes,
        idleMinutes: (now - chosen.mtimeMs) / 60_000,
        idle: idle !== undefined,
    };
}

/**
 * Every field either script reads, and nothing else. The token counts are a
 * plausible mid-session context so the percentage and delta arms take their
 * normal branches; no timing in the pipeline depends on their values.
 */
function buildPayload(repo: RepoTarget, transcript: TranscriptChoice): string {
    const payload = {
        hook_event_name: "Status",
        session_id: transcript.sessionId,
        transcript_path: transcript.path,
        cwd: repo.path,
        model: { id: "claude-opus-5", display_name: "Opus 5" },
        workspace: { current_dir: repo.path, project_dir: repo.path },
        version: "2.1.120",
        output_style: { name: "default" },
        context_window: {
            context_window_size: 1_000_000,
            current_usage: {
                input_tokens: 4821,
                cache_creation_input_tokens: 18_342,
                cache_read_input_tokens: 412_903,
                output_tokens: 1204,
            },
        },
    };
    return SafeJSON.stringify(payload);
}

function benchEnv(repo: RepoTarget, extra: Record<string, string> = {}): Record<string, string> {
    const base: Record<string, string> = {};

    for (const [key, value] of Object.entries(env.getProcessEnv())) {
        if (value !== undefined) {
            base[key] = value;
        }
    }

    return { ...base, CLAUDE_PROJECT_DIR: repo.path, ...extra };
}

interface HyperfineArm {
    /** Per-run wall time in milliseconds. */
    times: number[];
    /** Mean user CPU time per run, milliseconds. */
    userMs: number;
    /** Mean system CPU time per run, milliseconds. */
    systemMs: number;
}

async function runHyperfine(args: {
    command: string;
    payloadPath: string;
    repo: RepoTarget;
    runs: number;
    warmup: number;
    exportPath: string;
}): Promise<HyperfineArm> {
    const argv = [
        "hyperfine",
        "--runs",
        String(args.runs),
        "--warmup",
        String(args.warmup),
        "--style",
        "none",
        "--input",
        args.payloadPath,
        "--command-name",
        args.repo.name,
        "--export-json",
        args.exportPath,
        args.command,
    ];
    const proc = Bun.spawn(argv, {
        cwd: args.repo.path,
        env: benchEnv(args.repo),
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stderr] = await Promise.all([new Response(proc.stderr).text(), new Response(proc.stdout).text()]);
    await proc.exited;

    if (proc.exitCode !== 0) {
        throw new Error(`hyperfine exited ${proc.exitCode} for ${args.repo.name}: ${stderr.trim()}`);
    }

    const parsed = SafeJSON.parse(await Bun.file(args.exportPath).text(), { strict: true }) as {
        results: { times: number[]; user: number; system: number; exit_codes: number[] }[];
    };
    const result = parsed.results[0];

    if (result === undefined) {
        throw new Error(`hyperfine wrote no results for ${args.repo.name}.`);
    }

    const failures = result.exit_codes.filter((code) => code !== 0);

    if (failures.length > 0) {
        throw new Error(`${failures.length} of ${result.exit_codes.length} renders failed in ${args.repo.name}.`);
    }

    if (stderr.includes("Warning")) {
        log.warn({ repo: args.repo.name, stderr: stderr.trim() }, "hyperfine reported a warning");
    }

    return {
        times: result.times.map((seconds) => seconds * 1000),
        userMs: result.user * 1000,
        systemMs: result.system * 1000,
    };
}

function summarize(times: number[], userMs: number[], systemMs: number[]): TimingStats {
    const sorted = [...times].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const lower = sorted[middle - 1] ?? 0;
    const upper = sorted[middle] ?? 0;
    const median = sorted.length % 2 === 0 ? (lower + upper) / 2 : upper;
    const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

    return {
        meanMs: mean(sorted),
        medianMs: median,
        minMs: sorted[0] ?? 0,
        maxMs: sorted.at(-1) ?? 0,
        userMs: mean(userMs),
        systemMs: mean(systemMs),
        samples: sorted.length,
    };
}

interface ShimSet {
    /** Every wrapper directory, in the order they are prepended to the render's PATH. */
    dirs: string[];
    resolved: string[];
    unresolved: string[];
}

/**
 * Write one counting wrapper per shimmed binary, EACH IN ITS OWN DIRECTORY, and
 * hand the real binary a PATH with that one directory removed.
 *
 * The per-directory split is not tidiness, it is the whole safety mechanism. A
 * wrapper that leaves its own directory on the child's PATH turns any binary
 * that re-resolves its own name into a fork bomb, and one of these binaries
 * does exactly that: `grep` on this Mac is a Bun-compiled guard at
 * `~/.aliases/agents-find/bin/grep` which looks `grep` up again internally. A
 * single flat shim directory sent that to 4262 live processes and a load
 * average of 722 on 2026-09-16 18:00 before it was killed. Removing only the
 * wrapper's own directory keeps every OTHER wrapper visible, so `tools` calling
 * `bun`, or `node` calling `git`, is still counted.
 */
function writeShims(shimRoot: string, basePath: string): ShimSet {
    mkdirSync(shimRoot, { recursive: true });
    const resolved: string[] = [];
    const unresolved: string[] = [];
    const reals = new Map<string, string>();

    for (const name of SHIMMED_BINARIES) {
        const real = Bun.which(name);

        if (real === null) {
            log.debug({ name }, "binary is not on PATH; it cannot be counted");
            unresolved.push(name);
            continue;
        }

        reals.set(name, real);
        resolved.push(name);
    }

    const dirs = resolved.map((name) => join(shimRoot, name));

    for (const name of resolved) {
        const own = join(shimRoot, name);
        mkdirSync(own, { recursive: true });
        const childPath = [...dirs.filter((dir) => dir !== own), basePath].join(":");
        const script = [
            "#!/bin/sh",
            `printf '%s\\n' ${name} >> "$STATUSLINE_BENCH_COUNTER"`,
            `PATH='${childPath}'`,
            "export PATH",
            `exec '${reals.get(name)}' "$@"`,
            "",
        ].join("\n");
        const shimPath = join(own, name);
        writeFileSync(shimPath, script, { mode: 0o755 });
    }

    return { dirs, resolved, unresolved };
}

/**
 * One un-timed render with the wrappers on PATH. The backgrounded `curl` the
 * render fires outlives its parent, so the counter is read after a short settle
 * rather than the instant the shell exits.
 *
 * `RUNAWAY_SPAWNS` is a circuit breaker, not a sanity check. A render performs
 * on the order of fifty external calls; a count in the thousands means a
 * wrapper is recursing and the caller must be told loudly rather than handed a
 * number.
 */
const RUNAWAY_SPAWNS = 400;

async function countSpawns(args: {
    command: string;
    payloadPath: string;
    repo: RepoTarget;
    shims: ShimSet;
    basePath: string;
}): Promise<SpawnTally> {
    const counterPath = join(WORK_DIR, `spawns-${args.repo.name}.log`);
    await Bun.write(counterPath, "");
    const proc = Bun.spawn(["sh", "-c", args.command], {
        cwd: args.repo.path,
        env: benchEnv(args.repo, {
            PATH: [...args.shims.dirs, args.basePath].join(":"),
            STATUSLINE_BENCH_COUNTER: counterPath,
        }),
        stdin: Bun.file(args.payloadPath),
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stderr] = await Promise.all([new Response(proc.stderr).text(), new Response(proc.stdout).text()]);
    await proc.exited;

    if (proc.exitCode !== 0) {
        log.warn({ repo: args.repo.name, exitCode: proc.exitCode, stderr: stderr.trim() }, "counting render failed");
    }

    await Bun.sleep(500);
    const lines = (await Bun.file(counterPath).text()).split("\n").filter((line) => line.length > 0);
    const byBinary: Record<string, number> = {};

    for (const line of lines) {
        byBinary[line] = (byBinary[line] ?? 0) + 1;
    }

    if (lines.length > RUNAWAY_SPAWNS) {
        throw new Error(
            `${lines.length} external calls counted in ${args.repo.name}, over the ${RUNAWAY_SPAWNS} ceiling. ` +
                "A wrapper is recursing; kill any leftover processes before running this again."
        );
    }

    return { total: lines.length, byBinary };
}

/**
 * The account segment is the one piece of the render that names a real
 * subscription account, so it is replaced before the sample reaches a tracked
 * file. Everything else is kept byte-for-byte, which is the point of the sample.
 */
function redactAccount(text: string): string {
    return text.replace(/⚿\s+\S+/gu, "⚿ <account>");
}

/**
 * Where a repo's rendered sample is written. The default command owns the plain
 * `<repo>.txt` name; any other command gets its own suffix, so benchmarking a
 * replacement cannot overwrite the very samples it is supposed to be compared
 * against.
 */
function commandLabel(command: string): string {
    if (command === DEFAULT_COMMAND) {
        return "current";
    }

    if (command.includes("statusline/run.ts")) {
        return "inprocess";
    }

    if (command.includes("ai statusline run")) {
        return "via-tools";
    }

    return "alternative";
}

function samplePathFor(repo: RepoTarget, command: string): string {
    if (command === DEFAULT_COMMAND) {
        return join(SAMPLES_DIR, `${repo.name}.txt`);
    }

    return join(SAMPLES_DIR, `${repo.name}.${commandLabel(command)}.txt`);
}

async function captureSample(args: { command: string; payloadPath: string; repo: RepoTarget }): Promise<string> {
    const proc = Bun.spawn(["sh", "-c", args.command], {
        cwd: args.repo.path,
        env: benchEnv(args.repo),
        stdin: Bun.file(args.payloadPath),
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;

    if (proc.exitCode !== 0) {
        log.warn({ repo: args.repo.name, exitCode: proc.exitCode, stderr: stderr.trim() }, "sample render failed");
    }

    return redactAccount(stripAnsi(stdout)).trimEnd();
}

function metricsFor(results: RepoResult[]): BaselineMetrics {
    const metrics: BaselineMetrics = {};

    for (const result of results) {
        const key = result.repo.name;
        metrics[`${key}.medianMs`] = Number(result.timing.medianMs.toFixed(2));
        metrics[`${key}.meanMs`] = Number(result.timing.meanMs.toFixed(2));
        metrics[`${key}.minMs`] = Number(result.timing.minMs.toFixed(2));
        metrics[`${key}.maxMs`] = Number(result.timing.maxMs.toFixed(2));
        metrics[`${key}.userMs`] = Number(result.timing.userMs.toFixed(2));
        metrics[`${key}.systemMs`] = Number(result.timing.systemMs.toFixed(2));
        metrics[`${key}.childProcessesPerRender`] = result.spawns.total;
    }

    return metrics;
}

function renderTables(results: RepoResult[], transcript: TranscriptChoice, args: Args): void {
    renderCliHeader("Statusline render", `${args.runs} runs over ${args.rounds} interleaved rounds per repo`);

    const timing = createBoxTable(["REPO", "MEDIAN", "MEAN", "MIN", "MAX", "USER", "SYSTEM", "PROCS"]);

    for (const result of results) {
        timing.push([
            result.repo.name,
            `${result.timing.medianMs.toFixed(1)} ms`,
            `${result.timing.meanMs.toFixed(1)} ms`,
            `${result.timing.minMs.toFixed(1)} ms`,
            `${result.timing.maxMs.toFixed(1)} ms`,
            `${result.timing.userMs.toFixed(1)} ms`,
            `${result.timing.systemMs.toFixed(1)} ms`,
            String(result.spawns.total),
        ]);
    }

    out.println(timing.toString());

    renderCliSection("External binaries per render");
    const names = [...new Set(results.flatMap((result) => Object.keys(result.spawns.byBinary)))].sort();
    const spawns = createBoxTable(["BINARY", ...results.map((result) => result.repo.name)]);

    for (const name of names) {
        spawns.push([name, ...results.map((result) => String(result.spawns.byBinary[name] ?? 0))]);
    }

    out.println(spawns.toString());

    renderCliSection("Rendered samples (ANSI stripped, account redacted)");

    for (const result of results) {
        out.println(`${result.repo.name}:`);

        for (const line of result.sample.split("\n")) {
            out.println(`  ${line}`);
        }
    }

    renderCliSection("Harness");
    out.println(`  command      ${args.command}`);
    out.println(`  transcript   ${transcript.path}`);
    out.println(
        `  transcript   ${(transcript.bytes / 1_048_576).toFixed(1)} MiB, idle ${transcript.idleMinutes.toFixed(0)} min` +
            `${transcript.idle ? "" : " — NOT IDLE, this session's delta state was written to"}`
    );
    out.println(
        `  load avg     ${loadavg()
            .map((value) => value.toFixed(2))
            .join(" ")}`
    );
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const { present, missing } = existingRepos(args.repos);

    if (present.length === 0) {
        throw new Error("None of the repo targets exist; pass --repos <path,path>.");
    }

    for (const repo of missing) {
        out.log.warn(`Skipping ${repo.name}: ${repo.path} does not exist.`);
    }

    const transcript = pickTranscript(args.transcript);

    if (!transcript.idle) {
        out.log.warn(
            `No transcript has been idle for ${IDLE_MINUTES} min; using ${transcript.sessionId}, ` +
                "whose token-delta state file this run will append to."
        );
    }

    mkdirSync(WORK_DIR, { recursive: true });
    mkdirSync(SAMPLES_DIR, { recursive: true });

    const payloads = new Map<string, string>();

    for (const repo of present) {
        const payloadPath = join(WORK_DIR, `payload-${repo.name}.json`);
        await Bun.write(payloadPath, buildPayload(repo, transcript));
        payloads.set(repo.name, payloadPath);
    }

    // Asking for fewer runs than rounds would otherwise round UP to one run per
    // round and quietly measure more than `--runs` says, which a smoke run of 3
    // must not do.
    const rounds = Math.min(args.rounds, args.runs);
    const runsPerRound = Math.max(1, Math.floor(args.runs / rounds));
    // Report what ran, not what was asked for: an uneven split measures fewer
    // runs than `--runs` names, and a header that hides that is a lie.
    args.rounds = rounds;
    args.runs = rounds * runsPerRound;
    const times = new Map<string, number[]>(present.map((repo) => [repo.name, []]));
    const userMs = new Map<string, number[]>(present.map((repo) => [repo.name, []]));
    const systemMs = new Map<string, number[]>(present.map((repo) => [repo.name, []]));

    for (let round = 0; round < rounds; round += 1) {
        for (const repo of present) {
            const payloadPath = payloads.get(repo.name);

            if (payloadPath === undefined) {
                continue;
            }

            log.info({ repo: repo.name, round: round + 1, runs: runsPerRound }, "running hyperfine arm");
            const arm = await runHyperfine({
                command: args.command,
                payloadPath,
                repo,
                runs: runsPerRound,
                warmup: args.warmup,
                exportPath: join(WORK_DIR, `hyperfine-${repo.name}-${round}.json`),
            });
            times.get(repo.name)?.push(...arm.times);
            userMs.get(repo.name)?.push(arm.userMs);
            systemMs.get(repo.name)?.push(arm.systemMs);
        }
    }

    const basePath = env.getProcessEnv().PATH ?? "";
    const shims = writeShims(join(WORK_DIR, "shims"), basePath);
    log.info({ resolved: shims.resolved.length, unresolved: shims.unresolved }, "spawn-counting wrappers written");

    const results: RepoResult[] = [];

    for (const repo of present) {
        const payloadPath = payloads.get(repo.name);

        if (payloadPath === undefined) {
            continue;
        }

        const spawns = await countSpawns({ command: args.command, payloadPath, repo, shims, basePath });
        const sample = await captureSample({ command: args.command, payloadPath, repo });
        const samplePath = samplePathFor(repo, args.command);
        await Bun.write(samplePath, `${sample}\n`);
        results.push({
            repo,
            timing: summarize(times.get(repo.name) ?? [], userMs.get(repo.name) ?? [], systemMs.get(repo.name) ?? []),
            spawns,
            sample,
            samplePath,
        });
    }

    renderTables(results, transcript, args);

    const metrics = metricsFor(results);

    if (args.baseline) {
        const notes =
            `${args.runs} runs over ${args.rounds} interleaved rounds per repo, hyperfine --input, ` +
            `command "${args.command}". childProcessesPerRender counts external binary invocations ` +
            `via PATH wrappers and is a floor. Unshimmed: ${shims.unresolved.join(", ") || "none"}.`;
        const recorded = await recordBaseline({ name: args.baselineName, metrics, notes });
        out.log.success(`Recorded baseline "${recorded.name}" at commit ${recorded.commit}.`);
    }

    if (args.compare) {
        const comparison = await compareToBaseline({ name: args.baselineName, metrics, tolerancePct: 15 });
        out.println(formatComparison(comparison));

        if (!comparison.ok) {
            process.exitCode = 1;
        }
    }

    if (args.json) {
        out.result({
            command: args.command,
            transcript: { path: transcript.path, bytes: transcript.bytes, idle: transcript.idle },
            runs: args.runs,
            rounds: args.rounds,
            repos: results.map((result) => ({
                name: result.repo.name,
                path: result.repo.path,
                ...result.timing,
                childProcessesPerRender: result.spawns.total,
                spawnsByBinary: result.spawns.byBinary,
                sample: result.sample,
                samplePath: result.samplePath,
            })),
            metrics,
        });
    }
}

await main();
