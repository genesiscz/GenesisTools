import { rmSync } from "node:fs";

/**
 * Windows-resilient recursive remove.
 *
 * On Windows a file cannot be deleted while any handle is open, and the OS
 * keeps a brief lock *after* `Database.close()` / stream close — so an
 * immediate `unlinkSync`/`rmSync` of a just-closed sqlite file or its temp
 * dir fails with `EBUSY`/`EPERM` (the dominant cross-platform test-failure
 * cluster). Node's `rm` `maxRetries`/`retryDelay` exist for exactly this:
 * they only take effect on Windows for `EBUSY`/`EMFILE`/`ENOTEMPTY`/`EPERM`,
 * so this is a transparent no-op cost on macOS/Linux.
 *
 * ALWAYS remove temp files/dirs in tests and tooling through this (or
 * {@link removeDbFile}) — never a bare `rmSync`/`unlinkSync` — so the retry
 * policy lives in one place.
 */
export function removeRecursive(path: string): void {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
