/**
 * What a watch driver sees on a scratch repository, per driver and per kind of root (an ordinary checkout and a linked
 * worktree): closed-file edits found, writes to a file that stays open, the create event of a file held open, a
 * truncating write into a clean tracked file, and the fence wall time (p50, p99).
 *
 *   bun scripts/benchmarks/hooks/watch-driver-probe.ts --driver watchman --trials 200
 *
 * The Watchman arm runs a private daemon (its own socket, state and log under the scratch folder), points a child
 * process at it through `WATCHMAN_SOCK`, and stops it at the end. A held-open miss is a known limit, not a defect.
 */
import {
    appendFileSync,
    closeSync,
    fsyncSync,
    mkdtempSync,
    openSync,
    realpathSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { isWatchDriverId, WATCH_DRIVERS, type WatchDriverId } from "@genesiscz/utils/fs/watch-driver/registry";
import type { WatchedRoot } from "@genesiscz/utils/fs/watch-driver/types";
import { worktreeGitDir } from "@genesiscz/utils/git/hook-status";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { formatTable } from "@genesiscz/utils/table";
import { startPrivateWatchman } from "./private-watchman";

const FILES = 50;
const HELD_TRIALS = 5;
const FENCE_MS = 500;

interface RootResult {
    kind: string;
    opened: boolean;
    detail?: string;
    closedFound: number;
    closedTrials: number;
    heldFound: number;
    createHeldFound: number;
    truncateFound: number;
    losses: Record<string, number>;
    fenceP50: number | null;
    fenceP99: number | null;
}

function argValue(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

function git(cwd: string, args: string[]): void {
    const run = Bun.spawnSync(["git", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: {
            ...env.getProcessEnv(),
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_AUTHOR_NAME: "Probe",
            GIT_AUTHOR_EMAIL: "probe@example.com",
            GIT_COMMITTER_NAME: "Probe",
            GIT_COMMITTER_EMAIL: "probe@example.com",
        },
    });

    if (run.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${run.stderr.toString()}`);
    }
}

function percentile(values: number[], p: number): number | null {
    if (values.length === 0) {
        return null;
    }

    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function boundary(watched: WatchedRoot, since: string | null, losses: Record<string, number>) {
    const answer = await watched.changesSince(since, { fenceMs: FENCE_MS });

    if (answer.kind === "lost") {
        losses[answer.reason] = (losses[answer.reason] ?? 0) + 1;
        const fresh = await watched.changesSince(null, { fenceMs: FENCE_MS });
        return { clock: fresh.kind === "changes" ? fresh.clock : null, paths: new Set<string>(), fenceMs: null };
    }

    return {
        clock: answer.clock,
        paths: new Set(answer.changes.map((change) => change.path)),
        fenceMs: answer.fenceMs,
    };
}

async function probeRoot(options: {
    id: WatchDriverId;
    root: string;
    kind: string;
    trials: number;
}): Promise<RootResult> {
    const { root, kind, trials } = options;
    const result: RootResult = {
        kind,
        opened: false,
        closedFound: 0,
        closedTrials: trials,
        heldFound: 0,
        createHeldFound: 0,
        truncateFound: 0,
        losses: {},
        fenceP50: null,
        fenceP99: null,
    };
    const driver = await WATCH_DRIVERS[options.id].load();
    const gitDir = worktreeGitDir(root) ?? join(root, ".git");
    const opened = await driver.open({ root, gitDir });

    if (!opened.ok) {
        result.detail = `${opened.reason}: ${opened.detail}`;
        await driver.dispose();
        return result;
    }

    result.opened = true;
    const watched = opened.watched;
    const fences: number[] = [];
    let clock = (await boundary(watched, null, result.losses)).clock;

    for (let i = 0; i < trials; i++) {
        const file = `f${i % FILES}.txt`;
        appendFileSync(join(root, file), `${i}\n`);
        const answer = await boundary(watched, clock, result.losses);
        clock = answer.clock;

        if (answer.paths.has(file)) {
            result.closedFound += 1;
        }

        if (answer.fenceMs !== null) {
            fences.push(answer.fenceMs);
        }
    }

    for (let i = 0; i < HELD_TRIALS; i++) {
        const heldFile = `f${i}.txt`;
        const fd = openSync(join(root, heldFile), "a");
        clock = (await boundary(watched, clock, result.losses)).clock;
        writeSync(fd, `held ${i}\n`);
        fsyncSync(fd);
        const held = await boundary(watched, clock, result.losses);
        clock = held.clock;
        result.heldFound += held.paths.has(heldFile) ? 1 : 0;
        closeSync(fd);
        clock = (await boundary(watched, clock, result.losses)).clock;

        const created = `new-${Date.now()}-${i}.txt`;
        const createFd = openSync(join(root, created), "w");
        writeSync(createFd, "x\n");
        const createAnswer = await boundary(watched, clock, result.losses);
        clock = createAnswer.clock;
        result.createHeldFound += createAnswer.paths.has(created) ? 1 : 0;
        closeSync(createFd);
        clock = (await boundary(watched, clock, result.losses)).clock;

        const clean = `c${i}.txt`;
        const truncFd = openSync(join(root, clean), "w");
        writeSync(truncFd, "truncated\n");
        const truncAnswer = await boundary(watched, clock, result.losses);
        clock = truncAnswer.clock;
        result.truncateFound += truncAnswer.paths.has(clean) ? 1 : 0;
        closeSync(truncFd);
        clock = (await boundary(watched, clock, result.losses)).clock;
    }

    result.fenceP50 = percentile(fences, 50);
    result.fenceP99 = percentile(fences, 99);
    await watched.close();
    await driver.dispose();
    return result;
}

function makeRepo(scratch: string): { main: string; linked: string } {
    const main = join(scratch, "repo");
    Bun.spawnSync(["mkdir", "-p", main]);
    git(main, ["init", "-q", "-b", "main"]);

    for (let i = 0; i < FILES; i++) {
        writeFileSync(join(main, `f${i}.txt`), `file ${i}\n`);
    }

    for (let i = 0; i < HELD_TRIALS * 2; i++) {
        writeFileSync(join(main, `c${i}.txt`), `clean ${i}\n`);
    }

    git(main, ["add", "."]);
    git(main, ["commit", "-q", "-m", "base"]);
    const linked = join(scratch, "linked");
    git(main, ["worktree", "add", "-q", linked, "-b", "probe"]);
    return { main, linked };
}

async function child(): Promise<void> {
    const id = argValue("--driver") ?? "";
    const trials = Number(argValue("--trials") ?? "200");
    const outFile = argValue("--out") ?? "";

    if (!isWatchDriverId(id)) {
        throw new Error(`unknown driver ${id}`);
    }

    const results = [
        await probeRoot({ id, root: argValue("--main") ?? "", kind: "checkout", trials }),
        await probeRoot({
            id,
            root: argValue("--linked") ?? "",
            kind: "linked worktree",
            trials: Math.ceil(trials / 4),
        }),
    ];
    writeFileSync(outFile, SafeJSON.stringify(results));
}

async function parent(): Promise<void> {
    const id = argValue("--driver") ?? "watchman";
    const trials = argValue("--trials") ?? "200";

    if (!isWatchDriverId(id)) {
        out.println(`--driver must be one of: ${Object.keys(WATCH_DRIVERS).join(", ")}`);
        process.exitCode = 1;
        return;
    }

    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "watch-driver-probe-")));
    const { main, linked } = makeRepo(scratch);
    const driver = await WATCH_DRIVERS[id].load();
    const available = await driver.available();
    await driver.dispose();
    out.println(
        `driver ${id}: ${available.ok ? `available, ${available.version}` : `not available (${available.reason})`}`
    );
    const daemon = driver.facts.outlivesProcess ? startPrivateWatchman(scratch) : null;
    const childEnv: Record<string, string | undefined> = { ...env.getProcessEnv() };

    if (daemon) {
        childEnv.WATCHMAN_SOCK = daemon.sock;
    }

    const outFile = join(scratch, "result.json");

    try {
        const run = Bun.spawnSync(
            [
                "bun",
                import.meta.path,
                "--child",
                "--driver",
                id,
                "--trials",
                trials,
                "--main",
                main,
                "--linked",
                linked,
                "--out",
                outFile,
            ],
            { env: childEnv, stdout: "inherit", stderr: "inherit", timeout: 160_000 }
        );

        if (run.exitCode !== 0) {
            out.println(`the probe child exited ${run.exitCode}`);
            process.exitCode = 1;
            return;
        }
    } finally {
        daemon?.stop();
    }

    const results: RootResult[] = SafeJSON.parse(await Bun.file(outFile).text(), { strict: true });
    const ms = (value: number | null) => (value === null ? "-" : value.toFixed(1));
    const rows = results.map((result) => [
        result.kind,
        result.opened ? "yes" : `no (${result.detail ?? ""})`,
        `${result.closedFound}/${result.closedTrials}`,
        `${result.heldFound}/${HELD_TRIALS}`,
        `${result.createHeldFound}/${HELD_TRIALS}`,
        `${result.truncateFound}/${HELD_TRIALS}`,
        ms(result.fenceP50),
        ms(result.fenceP99),
        Object.entries(result.losses)
            .map(([reason, count]) => `${reason} ${count}`)
            .join(", ") || "none",
    ]);
    out.println(
        formatTable(
            rows,
            [
                "root",
                "opened",
                "closed edits",
                "held writes",
                "create held",
                "truncate held",
                "fence p50 ms",
                "fence p99 ms",
                "losses",
            ],
            { alignRight: [2, 3, 4, 5, 6, 7] }
        )
    );
    out.println(`scratch: ${scratch}`);
}

if (process.argv.includes("--child")) {
    await child();
} else {
    await parent();
}
