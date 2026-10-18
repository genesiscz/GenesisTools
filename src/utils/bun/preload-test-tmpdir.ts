import { afterAll } from "bun:test";
import { lstatSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { TEST_RUNTIME_FLAG } from "@genesiscz/utils/test-process";
import { foreignTmuxSocketReason } from "./private-tmux-socket";

/**
 * Give every test process its own temp root, and remove it when the run is green.
 *
 * 🛑 preload-test-sandbox.ts DEPENDS on this file running first: it creates its
 * `gt-test-home-*` root with a bare `mkdtempSync(join(tmpdir(), ...))` and has no cleanup of
 * its own, so it self-cleans ONLY because the TMPDIR redirect below has already happened.
 * Keep this entry ABOVE it in `bunfig.toml`. Measured 2026-09-15: reordering leaks one home
 * directory per test file into the real temp folder, never removed.
 *
 * 799 call sites in the suite do `mkdtempSync(join(tmpdir(), "<prefix>-"))` and most never
 * remove the dir. Measured 2026-09-07 15:05: 17,949 entries and 1.45 GB in the per-user
 * temp folder, 4,880 of them `gt-test-home-*` from the sandbox preload alone, 6,568
 * distinct prefixes in all, growing by about 1,100 entries per ten minutes while agents
 * ran tests. Fixing that at every call site is the wrong altitude.
 *
 * `os.tmpdir()` reads TMPDIR (TEMP and TMP on Windows) on every call, so pointing the
 * variable at one fresh root here, before any test module loads, moves every fixture, the
 * `gt-test-home` sandbox and every child that inherits the environment into one
 * directory. One `rmSync` at exit then covers all of them.
 *
 * Rules:
 *  - Removed in a global `afterAll`, once per test process, green or red. `bun test` fires
 *    neither the `exit` nor the `beforeExit` event (measured on 1.3.13), and no hook sees
 *    the run's verdict, so "keep the evidence on red" is not available. A failed
 *    assertion is in the transcript; the fixture dir was never what anyone read.
 *  - Stale sibling roots (older than 6 h; no test process lives that long) are swept at
 *    the same point, at most 200 per process, so a KILLED run (no afterAll) cannot
 *    accumulate forever. Only the `gt-test-tmp-` prefix is ever touched: nothing else in
 *    the temp folder is ours.
 *  - Listed right after the sqlite-vec preload in bunfig.toml, BEFORE the sandbox preload,
 *    so the sandbox home lands inside this root.
 *
 * Known gap: Bun does not forward process.env mutations to children spawned without an
 * explicit `env`, so such a child still writes to the real temp folder. A test that spawns
 * passes `env: { ...process.env }` when that matters.
 */
/**
 * 🛑 Declare that this is a test runtime, for everything that must not touch real user data.
 *
 * bunfig's `[test] preload` applies to `bun test` and nothing else, so setting it here cannot
 * leak into production, and it is an environment variable so a subprocess a test spawns
 * inherits it. That is the hole `NODE_ENV` and `Bun.main` both have: see
 * `utils/test-process.ts` for the measurement that made a third signal necessary.
 */
env.testing.set(TEST_RUNTIME_FLAG, "1");

const PREFIX = "gt-test-tmp-";
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const MAX_SWEEP = 200;

const realTmpdir = tmpdir();
const root = mkdtempSync(join(realTmpdir, PREFIX));
for (const name of ["TMPDIR", "TMP", "TEMP"]) {
    // Writes straight through to process.env, which is what os.tmpdir() reads.
    env.testing.set(name, root);
}
// `@genesiscz/utils/paths`.tmpdir() reads no environment: it returns the literal "/tmp" so
// production temp paths stay short and stable. This marker is the one thing that redirects it,
// which is what brings the fixtures built through the repo helper into this root as well.
env.testing.set("GENESIS_TEST_TMP_ROOT", root);
// tmux ignores TMPDIR: its socket lives in TMUX_TMPDIR (default /tmp), and a set TMUX names the server of the
// pane the test runs in. So a test that ran `tmux` started or joined the USER's server, and the first such run
// became that server's founder: its global environment kept GENESIS_TOOLS_TEST_RUNTIME=1 and the agent's
// identity, which every dev-dashboard terminal then inherited (2026-09-14 and 2026-10-15). A private socket
// folder inside this root gives the run its own server, which dies with the root.
env.testing.set("TMUX_TMPDIR", root);
env.testing.unset("TMUX");

/**
 * The server on this run's private socket outlives the run: the dashboard's tmux code sets `exit-empty off`
 * (`ensureTmuxServerPersists` in src/utils/tmux/sessions.ts), and removing the folder only unlinks the socket. So
 * it is stopped by its exact socket path, and only when that path is a real socket inside this root, so it can never
 * name the user's server.
 */
const stopPrivateTmuxServer = (): void => {
    const uid = process.getuid?.();
    const tmux = Bun.which("tmux");
    const socket = join(root, `tmux-${uid}`, "default");

    if (uid === undefined || !tmux || !lstatSync(socket, { throwIfNoEntry: false })) {
        return;
    }

    // A symlink planted at the path would aim kill-server at a server outside this run.
    const foreign = foreignTmuxSocketReason(root, socket);
    if (foreign) {
        process.stderr.write(`[test] tmux kill-server skipped: ${socket} ${foreign}\n`);
        return;
    }

    const result = Bun.spawnSync([tmux, "-S", socket, "kill-server"], {
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 2_000,
    });

    if (result.exitCode !== 0) {
        process.stderr.write(`[test] tmux kill-server on ${socket} exited ${result.exitCode}: ${result.stderr}\n`);
    }
};

const sweepStale = (): void => {
    let names: string[];
    try {
        names = readdirSync(realTmpdir);
    } catch {
        // The temp folder itself is unreadable: nothing to sweep, nothing to report.
        return;
    }

    let removed = 0;
    for (const name of names) {
        if (removed >= MAX_SWEEP) {
            break;
        }

        if (!name.startsWith(PREFIX)) {
            continue;
        }

        const dir = join(realTmpdir, name);
        if (dir === root) {
            continue;
        }

        try {
            // A live run's root keeps a fresh mtime: every fixture created inside it touches it.
            if (Date.now() - statSync(dir).mtimeMs < STALE_AFTER_MS) {
                continue;
            }

            rmSync(dir, { recursive: true, force: true });
            removed += 1;
        } catch {
            // Vanished under us, or refused by the filesystem: the next run tries again.
        }
    }
};

afterAll(() => {
    stopPrivateTmuxServer();
    rmSync(root, { recursive: true, force: true });
    sweepStale();
});
