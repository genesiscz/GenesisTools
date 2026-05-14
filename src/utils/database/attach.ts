import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import logger from "@app/logger";

const SAFE_ALIAS_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * ATTACH a SQLite database file under `alias`, read-only by default.
 *
 * Builds the `file:` URI via the URL object so reserved characters in the
 * path are percent-encoded correctly, and applies `?mode=ro` so SQLite
 * refuses writes through the alias. `alias` is interpolated into the ATTACH
 * statement (SQLite cannot parameterise it) so it is validated as a bare SQL
 * identifier first.
 */
export function attachReadonly(db: Database, alias: string, dbPath: string, mode: "ro" | "rw" = "ro"): void {
    if (!SAFE_ALIAS_RE.test(alias)) {
        throw new Error(`Invalid attach alias: ${alias}`);
    }

    const uri = pathToFileURL(resolve(dbPath));
    if (mode === "ro") {
        uri.search = "mode=ro";
    }

    const escaped = uri.toString().replace(/'/g, "''");

    try {
        db.run(`ATTACH DATABASE '${escaped}' AS ${alias}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
            `Failed to attach SQLite database ${resolve(dbPath)} as ${alias} (${mode}): ${message}`,
            { cause: error }
        );
    }
}

/**
 * DETACH `alias`, logging (not throwing) on failure. A failed DETACH must
 * never mask the result of whatever query just used the attached DB. Also a
 * no-op for an unsafe alias, so it is safe to call from a `finally` after a
 * failed `attachReadonly`.
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
}
