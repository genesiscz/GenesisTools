import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "@app/logger";

const SAFE_ALIAS_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Per-connection read-only bookkeeping. `PRAGMA query_only` is connection-wide
 * (not alias-scoped), so it must be captured before the first read-only attach
 * and restored once the last read-only alias is detached — otherwise the flag
 * leaks past the attach/detach lifecycle and silently makes a read-write
 * connection (e.g. the indexer's index.db) reject all later writes.
 * Keyed by the Database instance so the state vanishes if the connection is
 * GC'd without a balancing detach.
 */
const roState = new WeakMap<Database, { prior: number; roAliases: Set<string> }>();

function readQueryOnly(db: Database): number {
    const row = db.query("PRAGMA query_only").get() as { query_only: number } | null;
    return row?.query_only ?? 0;
}

/**
 * ATTACH a SQLite database file under `alias`, read-only by default.
 *
 * Uses the plain resolved path (not a `file:` URI) so the ATTACH works
 * regardless of whether the connection was opened with `SQLITE_OPEN_URI`.
 * bun:sqlite's bundled SQLite has URI filenames disabled by default, so a
 * `file:…?mode=ro` URI is treated as a literal filename on Linux/Windows CI
 * (passes on macOS only because Homebrew SQLite has URI on).
 *
 * Read-only enforcement: when `mode === "ro"`, two layers are applied:
 *   1. A pre-flight existence check ensures the file is present before the
 *      ATTACH, mirroring `?mode=ro`'s refusal to create a new file.
 *   2. `PRAGMA query_only = 1` is set on the connection after attaching so
 *      SQLite refuses any writes. Because `query_only` is connection-wide,
 *      the prior value is captured here and restored by `detachQuietly` once
 *      the last read-only alias is detached — the read-only state is scoped
 *      to the attach/detach lifecycle, so a read-write connection stays
 *      writable for work after the attached data has been queried.
 *
 * Path safety: single quotes in the resolved path are doubled (`'`→`''`)
 * to prevent SQL injection. `alias` is validated as a bare SQL identifier
 * (SQLite cannot parameterise ATTACH aliases).
 */
export function attachReadonly(db: Database, alias: string, dbPath: string, mode: "ro" | "rw" = "ro"): void {
    if (!SAFE_ALIAS_RE.test(alias)) {
        throw new Error(`Invalid attach alias: ${alias}`);
    }

    const absPath = resolve(dbPath);

    if (mode === "ro" && !existsSync(absPath)) {
        throw new Error(`Failed to attach SQLite database ${absPath} as ${alias} (ro): file not found`, {
            cause: new Error(`ENOENT: no such file or directory, open '${absPath}'`),
        });
    }

    const escaped = absPath.replace(/'/g, "''");

    try {
        db.run(`ATTACH DATABASE '${escaped}' AS ${alias}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to attach SQLite database ${absPath} as ${alias} (${mode}): ${message}`, {
            cause: error,
        });
    }

    if (mode === "ro") {
        let state = roState.get(db);

        if (state === undefined) {
            state = { prior: readQueryOnly(db), roAliases: new Set() };
            roState.set(db, state);
        }

        state.roAliases.add(alias);
        db.run("PRAGMA query_only = 1");
    }
}

/**
 * DETACH `alias`, logging (not throwing) on failure. A failed DETACH must
 * never mask the result of whatever query just used the attached DB. Also a
 * no-op for an unsafe alias, so it is safe to call from a `finally` after a
 * failed `attachReadonly`. If `alias` was attached read-only, the connection's
 * `query_only` flag is restored to its pre-attach value once the last
 * read-only alias on this connection is detached.
 */
export function detachQuietly(db: Database, alias: string): void {
    if (!SAFE_ALIAS_RE.test(alias)) {
        return;
    }

    try {
        db.run(`DETACH DATABASE ${alias}`);
    } catch (err) {
        logger.debug(
            `[db/attach] DETACH ${alias} failed (ignored): ${err instanceof Error ? err.message : String(err)}`
        );
    }

    const state = roState.get(db);

    if (state?.roAliases.has(alias)) {
        state.roAliases.delete(alias);

        if (state.roAliases.size === 0) {
            db.run(`PRAGMA query_only = ${state.prior}`);
            roState.delete(db);
        }
    }
}
