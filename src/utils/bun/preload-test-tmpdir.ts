import { afterAll } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";

/**
 * Give every test process its own temp root, and remove it when the run is green.
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
const PREFIX = "gt-test-tmp-";
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const MAX_SWEEP = 200;

const realTmpdir = tmpdir();
const root = mkdtempSync(join(realTmpdir, PREFIX));
for (const name of ["TMPDIR", "TMP", "TEMP"]) {
    // Writes straight through to process.env, which is what os.tmpdir() reads.
    env.testing.set(name, root);
}

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
    rmSync(root, { recursive: true, force: true });
    sweepStale();
});
