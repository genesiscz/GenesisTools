import { rmSync } from "node:fs";

/** Transient Windows lock codes worth retrying after a closed handle. */
const RETRYABLE = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE", "EACCES"]);

function errCode(err: unknown): string | undefined {
    if (err != null && typeof err === "object" && "code" in err) {
        return String((err as { code?: unknown }).code);
    }

    return undefined;
}

/**
 * Windows-resilient, best-effort recursive remove.
 *
 * On Windows a file can't be deleted while any handle is open, and the OS
 * keeps a brief lock *after* `Database.close()` / stream close — so an
 * immediate `rmSync` of a just-closed sqlite file or its temp dir throws
 * `EBUSY`/`EPERM` (the dominant cross-platform test-failure cluster). Node
 * documents `rm` `maxRetries`/`retryDelay` for this, but **bun's `rmSync`
 * does not honor them** on the Windows runner, so we run the retry loop
 * ourselves with `Bun.sleepSync`.
 *
 * Best-effort by design: after exhausting retries it returns instead of
 * throwing. A leftover temp file is harmless — the age-gated
 * `test-cleanup-preload` reaps stale ones — whereas a throw out of a test
 * `afterEach` fails an otherwise-passing test. First attempt is instant on
 * macOS/Linux (no lock), so this is a no-op cost off Windows.
 *
 * ALWAYS remove temp files/dirs in tests and tooling through this (or
 * {@link removeDbFile}) — never a bare `rmSync`/`unlinkSync`.
 */
export function removeRecursive(path: string, maxAttempts = 20, delayMs = 25): void {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            rmSync(path, { recursive: true, force: true });
            return;
        } catch (err) {
            const code = errCode(err);

            if (code === undefined || !RETRYABLE.has(code)) {
                throw err;
            }

            if (attempt === maxAttempts) {
                return;
            }

            Bun.sleepSync(delayMs);
        }
    }
}

/**
 * Remove a SQLite database file together with its WAL/SHM/journal sidecars
 * (`-wal`, `-shm`, `-journal`), each via {@link removeRecursive}. `force` is
 * implied, so absent sidecars are ignored.
 *
 * Call `db.close()` first — this only defeats the *post-close* Windows lock
 * lag, not an actively-open handle.
 */
export function removeDbFile(dbPath: string): void {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        removeRecursive(dbPath + suffix);
    }
}
