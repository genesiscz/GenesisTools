import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWatchdogScript } from "@genesiscz/utils/bun/orphan-worker-guard";
import { SafeJSON } from "@genesiscz/utils/json";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { skip } from "@genesiscz/utils/test/skip";

const guardPath = join(import.meta.dir, "orphan-worker-guard.ts");

/**
 * The same `ps -o lstart=` reading the guard itself does, including the whitespace
 * normalisation — the shell side collapses the column's padding, so a value trimmed any
 * other way never compares equal and the kill silently never fires.
 */
function startedAtForTest(pid: number): string | null {
    try {
        const started = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", env: process.env })
            .replace(/\s+/g, " ")
            .trim();

        return started.length > 0 ? started : null;
    } catch {
        return null;
    }
}

/**
 * Probe children load modules by absolute path for the same reason `guardPath`
 * exists: they run outside the repo's alias graph, so `@genesiscz/...` does not
 * resolve in them.
 */
const processAlivePath = join(import.meta.dir, "..", "process-alive.ts");
const leftovers: number[] = [];

/**
 * CI exports `GENESIS_TOOLS_TEST_ALLOW_ORPHAN_WORKERS=1` for the whole `bun run test` step, and
 * `installOrphanWorkerGuard` returns immediately on that value. A child inheriting it would make
 * this suite report on the environment instead of on the guard, so every spawn pins the flag to
 * what its own case needs: armed children install the guard, the control child never does.
 */
function childEnv(guard: boolean): Record<string, string | undefined> {
    return { ...process.env, GENESIS_TOOLS_TEST_ALLOW_ORPHAN_WORKERS: guard ? "0" : "1" };
}

/**
 * The watchdog is a `/bin/sh` whose script embeds the guarded pid, so pgrep finds it by that.
 *
 * `-f` matches a substring of the WHOLE command line, so an unanchored `self=123` also matches
 * a sibling worker's `self=1234`. The `([^0-9]|$)` lookalike-of-a-boundary rules that out: two
 * concurrent guarded pids only collide when one is a numeric prefix of the other.
 */
function watchdogRunning(selfPid: number): boolean {
    const found = Bun.spawnSync(["pgrep", "-f", `self=${selfPid}([^0-9]|$)`], { env: process.env });
    return found.stdout.toString().trim().length > 0;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (predicate()) {
            return true;
        }

        await Bun.sleep(50);
    }

    return predicate();
}

async function spawnBusyChild(opts: { guard: boolean }): Promise<{ middlePid: number; childPid: number }> {
    const dir = mkdtempSync(join(tmpdir(), "orphan-worker-"));
    const pidFile = join(dir, "child.pid");
    const readyFile = join(dir, "ready");
    const childSource = opts.guard
        ? `import { installOrphanWorkerGuard } from ${SafeJSON.stringify(guardPath)};
import { writeFileSync } from "node:fs";
installOrphanWorkerGuard({ pollSeconds: 0.25 });
writeFileSync(${SafeJSON.stringify(readyFile)}, "1");
for (;;) {}`
        : `import { writeFileSync } from "node:fs";
writeFileSync(${SafeJSON.stringify(readyFile)}, "1");
for (;;) {}`;
    const childFile = join(dir, "busy.ts");
    writeFileSync(childFile, childSource);

    const middle = Bun.spawn({
        cmd: [
            process.execPath,
            "-e",
            `
const child = Bun.spawn({
  cmd: [${SafeJSON.stringify(process.execPath)}, ${SafeJSON.stringify(childFile)}],
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
});
await Bun.write(${SafeJSON.stringify(pidFile)}, String(child.pid));
await Bun.sleep(1 << 30);
`,
        ],
        env: childEnv(opts.guard),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
    });
    leftovers.push(middle.pid);

    const ready = await waitUntil(() => {
        try {
            return Bun.file(pidFile).size > 0;
        } catch {
            return false;
        }
    }, 5_000);

    if (!ready) {
        throw new Error("middle process never wrote the child pid");
    }

    const childPid = Number.parseInt((await Bun.file(pidFile).text()).trim(), 10);
    leftovers.push(childPid);

    if (!Number.isFinite(childPid) || childPid <= 0) {
        throw new Error(`invalid child pid: ${childPid}`);
    }

    const armed = await waitUntil(() => {
        try {
            return Bun.file(readyFile).size > 0;
        } catch {
            return false;
        }
    }, 5_000);

    if (!armed) {
        throw new Error("child never armed (ready file missing)");
    }

    return { middlePid: middle.pid, childPid };
}

/**
 * Counts `/bin/sh` children of the running process. Inlined into a generated child rather than
 * imported, because these children load the guard from a bare path with no repo alias graph.
 */
const COUNT_OWN_SHELLS = `
function countOwnShells() {
    const ps = Bun.spawnSync(["ps", "-Ao", "ppid,comm"]);

    if (ps.stderr.toString().trim().length > 0) {
        throw new Error("ps failed: " + ps.stderr.toString());
    }

    return ps.stdout
        .toString()
        .split("\\n")
        .filter((line) => {
            const parts = line.trim().split(/\\s+/);
            return parts.length >= 2 && Number(parts[0]) === process.pid && /sh$/.test(parts[1] ?? "");
        }).length;
}

/**
 * Waits until at least \`min\` watchdog shells are visible to ps, then settles briefly.
 *
 * The four probes below used a flat 750 ms guess each. Polling for the shell to appear is
 * both faster and stricter, and the trailing settle keeps the point of the probes intact:
 * they count DUPLICATES, so a straggler second shell must still have time to show up before
 * the count is taken.
 */
async function settleShells(min) {
    const deadline = Date.now() + 5000;

    while (countOwnShells() < min && Date.now() < deadline) {
        await Bun.sleep(10);
    }

    await Bun.sleep(100);
}
`;

/** Runs a generated script in its own process and returns what it wrote to the result file. */
async function runProbeChild(body: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "orphan-worker-probe-"));
    const resultFile = join(dir, "result");
    const childFile = join(dir, "probe.ts");
    writeFileSync(
        childFile,
        `import { installOrphanWorkerGuard } from ${SafeJSON.stringify(guardPath)};
import { writeFileSync } from "node:fs";
${COUNT_OWN_SHELLS}
const RESULT_FILE = ${SafeJSON.stringify(resultFile)};
${body}
`
    );

    const child = Bun.spawn({
        cmd: [process.execPath, childFile],
        env: childEnv(true),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
    });
    leftovers.push(child.pid);

    const exitCode = await child.exited;
    if (exitCode !== 0) {
        throw new Error(`probe child exited ${exitCode}: ${await new Response(child.stderr).text()}`);
    }

    return (await Bun.file(resultFile).text()).trim();
}

afterEach(() => {
    for (const pid of leftovers.splice(0)) {
        try {
            process.kill(pid, "SIGKILL");
        } catch {
            // Already gone.
        }
    }
});

describe.skipIf(skip.onWindows)("orphan isolate-worker guard", () => {
    test("a busy-loop child survives SIGKILL of its parent (the 2026-09-08 class)", async () => {
        const { middlePid, childPid } = await spawnBusyChild({ guard: false });

        expect(isProcessAlive(childPid)).toBe(true);
        process.kill(middlePid, "SIGKILL");

        const stillAlive = await waitUntil(() => !isProcessAlive(middlePid), 2_000);
        expect(stillAlive).toBe(true);
        // The negative control, and it gets STRONGER rather than shorter: the guarded child
        // now polls every 0.25 s, so 750 ms spans three poll intervals, where 1500 ms spanned
        // less than a third of the five-second default.
        await Bun.sleep(750);
        expect(isProcessAlive(childPid)).toBe(true);
    });

    test("the guard SIGKILLs the child once the parent is gone", async () => {
        const { middlePid, childPid } = await spawnBusyChild({ guard: true });

        expect(isProcessAlive(childPid)).toBe(true);
        process.kill(middlePid, "SIGKILL");

        // One poll interval plus margin: the watchdog sleeps 5s between checks.
        const died = await waitUntil(() => !isProcessAlive(childPid), 15_000);
        expect(died).toBe(true);
    }, 30_000);

    /**
     * `bunfig.toml` preloads this guard, and `--isolate` re-evaluates every preload once per
     * test FILE. On 2026-09-14 one worker pid therefore owned 97 identical polling shells,
     * machine-wide ~1,141 `/bin/sh` and load average 278. Ten installs must leave one shell.
     */
    test("installing repeatedly in one process leaves exactly one watchdog", async () => {
        const count = await runProbeChild(`
for (let i = 0; i < 10; i += 1) {
    installOrphanWorkerGuard();
}

await settleShells(1);
writeFileSync(RESULT_FILE, String(countOwnShells()));
`);

        expect(count).toBe("1");
    }, 30_000);

    /**
     * The subtle half. A once-only flag also reports "already installed" after the watchdog has
     * died, and the shell spawned during a worker's FIRST test file is reliably dead by its
     * second, so such a guard leaves the rest of the run unprotected. Killing the watchdog and
     * installing again must produce a live replacement, not a no-op.
     */
    test("a watchdog that has died is replaced on the next install", async () => {
        const counts = await runProbeChild(`
import { isProcessAlive } from ${SafeJSON.stringify(processAlivePath)};

installOrphanWorkerGuard();
await settleShells(1);
const afterFirst = countOwnShells();

// Anchored the same way watchdogRunning() is, above: an unanchored "self=" + pid would also
// match a sibling worker's pid that starts with this one's digits, and this list gets SIGKILLed.
const found = Bun.spawnSync(["pgrep", "-f", "self=" + process.pid + "([^0-9]|$)"]);
const watchdogs = found.stdout
    .toString()
    .trim()
    .split("\\n")
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isFinite(pid) && pid > 0);

for (const pid of watchdogs) {
    process.kill(pid, "SIGKILL");
}

// SIGKILL alone leaves an unreaped zombie, which still answers signal 0. Wait for the
// real disappearance, so the second install faces a genuinely dead watchdog. This must
// use the SAME probe the guard itself uses to decide whether to reinstall, or the wait
// can end while the guard would still read the watchdog as alive.
const signalable = () => watchdogs.some((pid) => isProcessAlive(pid));

const deadline = Date.now() + 10_000;
while (signalable() && Date.now() < deadline) {
    await Bun.sleep(25);
}

installOrphanWorkerGuard();
await settleShells(1);
writeFileSync(RESULT_FILE, afterFirst + "," + countOwnShells());
`);

        expect(counts).toBe("1,1");
    }, 30_000);

    /**
     * The note records a bare pid, not the watchdog's identity. If that pid gets reissued to
     * an unrelated live program before this process installs again, `isProcessAlive` alone
     * reads it as "still guarded" and never installs a real watchdog for the rest of the run.
     * Simulated here by writing an unrelated but genuinely alive pid straight into the note.
     */
    test("a note pointing at an unrelated live process is not trusted as the watchdog", async () => {
        const count = await runProbeChild(`
import { mkdirSync } from "node:fs";

const NOTE_DIR = "/tmp/genesis-orphan-guard";
mkdirSync(NOTE_DIR, { recursive: true, mode: 0o700 });
const startSecond = Math.round((Date.now() - process.uptime() * 1000) / 1000);
const notePath = NOTE_DIR + "/" + process.pid + "-" + startSecond + ".pid";

// Genuinely alive, and genuinely not this guard's watchdog: no "self=<pid>" on its argv.
const impostor = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
await Bun.sleep(200);
writeFileSync(notePath, String(impostor.pid));

installOrphanWorkerGuard();
await settleShells(1);
writeFileSync(RESULT_FILE, String(countOwnShells()));
impostor.kill("SIGKILL");
`);

        expect(count).toBe("1");
    }, 30_000);

    // The preload installs the guard in every test process, so a watchdog that only
    // watched the parent would outlive each finished worker for the whole run.
    test("the watchdog ends with a worker that exits normally under a live parent", async () => {
        const dir = mkdtempSync(join(tmpdir(), "orphan-worker-exit-"));
        const readyFile = join(dir, "ready");
        const goFile = join(dir, "go");
        const childFile = join(dir, "exits.ts");
        writeFileSync(
            childFile,
            `import { existsSync, writeFileSync } from "node:fs";
import { installOrphanWorkerGuard } from ${SafeJSON.stringify(guardPath)};
installOrphanWorkerGuard({ pollSeconds: 0.25 });
writeFileSync(${SafeJSON.stringify(readyFile)}, "1");
while (!existsSync(${SafeJSON.stringify(goFile)})) {
    await Bun.sleep(20);
}
`
        );

        const child = Bun.spawn({
            cmd: [process.execPath, childFile],
            env: childEnv(true),
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
        });
        leftovers.push(child.pid);

        const armed = await waitUntil(() => Bun.file(readyFile).size > 0, 5_000);
        expect(armed).toBe(true);
        expect(watchdogRunning(child.pid)).toBe(true);

        writeFileSync(goFile, "1");
        await child.exited;
        expect(isProcessAlive(child.pid)).toBe(false);

        // This test process is the guarded worker's parent and is still alive, so
        // only the worker's own exit can end the watchdog.
        const stopped = await waitUntil(() => !watchdogRunning(child.pid), 15_000);
        expect(stopped).toBe(true);
    }, 30_000);

    /**
     * The other half of the identity rule, raised by CodeRabbit on PR #392.
     *
     * `kill -0 "$parent"` proves only that the NUMBER is occupied. When the original parent
     * exits and the kernel reissues its pid — about three minutes on macOS at the 400-800
     * pids/second this guard exists for — the probe keeps succeeding against a stranger, the
     * watchdog concludes "parent still alive", and the worker it was installed to reap is
     * left running forever. That is a leak rather than a wrong kill, so it fails in the safe
     * direction, but it defeats the guard in exactly the scenario that motivated it.
     *
     * Simulated by handing the script a parent that is genuinely alive together with the
     * start time of a DIFFERENT process, which is precisely what a recycled pid looks like.
     */
    // The interval is interpolated into /bin/sh and the script has no `set -e`, so `sleep 0`
    // (succeeds, returns instantly) and `sleep NaN` (fails, loop continues anyway) both turn the
    // watchdog into a busy loop on `ps` and `awk`.
    test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
        "a pollSeconds of %p cannot reach the shell: the script sleeps the default instead",
        (pollSeconds) => {
            const script = buildWatchdogScript({
                parentPid: 1,
                selfPid: 2,
                selfStart: "x",
                parentStart: "y",
                pollSeconds,
            });

            expect(script).toContain("sleep 5");
            expect(script).not.toContain(`sleep ${pollSeconds}`);
        }
    );

    test("a usable pollSeconds is still honoured", () => {
        const script = buildWatchdogScript({
            parentPid: 1,
            selfPid: 2,
            selfStart: "x",
            parentStart: "y",
            pollSeconds: 0.25,
        });

        expect(script).toContain("sleep 0.25");
    });

    test("a recycled parent pid counts as parent loss, not as a live parent", async () => {
        const parent = Bun.spawn(["sleep", "60"], { env: process.env, stdout: "ignore", stderr: "ignore" });
        const self = Bun.spawn(["sleep", "60"], { env: process.env, stdout: "ignore", stderr: "ignore" });
        leftovers.push(parent.pid, self.pid);

        const selfStart = startedAtForTest(self.pid);
        expect(selfStart).not.toBeNull();

        const watchdog = Bun.spawn(
            [
                "/bin/sh",
                "-c",
                buildWatchdogScript({
                    parentPid: parent.pid,
                    selfPid: self.pid,
                    selfStart: String(selfStart),
                    // Alive, but not the process the guard was installed under.
                    parentStart: "Thu Jan  1 00:00:00 1970",
                }),
            ],
            { env: process.env, stdout: "ignore", stderr: "ignore" }
        );
        leftovers.push(watchdog.pid);

        const reaped = await waitUntil(() => !isProcessAlive(self.pid), 20_000);
        expect(reaped).toBe(true);
    }, 40_000);

    /**
     * The negative control for the case above. A parent whose start time MATCHES is the
     * ordinary healthy state, and the worker must be left strictly alone — a guard that
     * reaped live workers would be far worse than the leak it fixes.
     */
    test("a parent whose start time still matches leaves the worker alone", async () => {
        const parent = Bun.spawn(["sleep", "60"], { env: process.env, stdout: "ignore", stderr: "ignore" });
        const self = Bun.spawn(["sleep", "60"], { env: process.env, stdout: "ignore", stderr: "ignore" });
        leftovers.push(parent.pid, self.pid);

        const selfStart = startedAtForTest(self.pid);
        const parentStart = startedAtForTest(parent.pid);
        // Both, not just the parent: a null selfStart becomes the literal string "null" below, and
        // the live parent means the script exits before it ever compares the worker identity. The
        // test would then pass with no worker fixture at all.
        expect(selfStart).not.toBeNull();
        expect(parentStart).not.toBeNull();

        const watchdog = Bun.spawn(
            [
                "/bin/sh",
                "-c",
                buildWatchdogScript({
                    parentPid: parent.pid,
                    selfPid: self.pid,
                    selfStart: String(selfStart),
                    parentStart: String(parentStart),
                    pollSeconds: 0.25,
                }),
            ],
            { env: process.env, stdout: "ignore", stderr: "ignore" }
        );
        leftovers.push(watchdog.pid);

        // THREE poll intervals with margin, where the five-second default bought two for
        // 12 s. The window this test needs is measured in polls, not in seconds: a watchdog
        // that was going to misfire does so on a poll, and shortening the interval gives it
        // more chances to, not fewer. 12.09 s -> 0.8 s.
        await Bun.sleep(750);
        expect(isProcessAlive(self.pid)).toBe(true);
    }, 40_000);
});
