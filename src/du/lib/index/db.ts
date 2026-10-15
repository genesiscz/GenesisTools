import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, statfsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { runMigrations } from "@genesiscz/utils/database/migrations";
import { applyPragmas } from "@genesiscz/utils/database/pragmas";
import { logger } from "@genesiscz/utils/logger";
import { classifyPid } from "@genesiscz/utils/process-identity";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { INDEX_MIGRATIONS, MIGRATION_SCOPE, SCHEMA_VERSION } from "./schema";
import { IndexError } from "./types";

const log = logger.child({ component: "du:index:db" });

/** `~/.genesis-tools/du/index.db` (under GENESIS_TOOLS_HOME in tests). */
export function defaultDbPath(): string {
    return toolDataDir("du", "index.db");
}

/** One writer at a time: `build` and `update` hold this file while they work. */
export function lockPathFor(dbPath: string): string {
    return `${dbPath}.lock`;
}

/** Free bytes on the volume that holds `path` (the nearest existing ancestor). */
export function freeBytesAt(path: string): number {
    let dir = path;
    while (!existsSync(dir) && dirname(dir) !== dir) {
        dir = dirname(dir);
    }

    const s = statfsSync(dir);
    return s.bavail * s.bsize;
}

/** The pid named in a lock file, for the `locked` message. */
export function lockHolderPid(lockPath: string): number | null {
    try {
        const m = /"pid"\s*:\s*(\d+)|^(\d+)/.exec(readFileSync(lockPath, "utf8"));
        const pid = m ? Number(m[1] ?? m[2]) : Number.NaN;
        return Number.isFinite(pid) ? pid : null;
    } catch (err) {
        log.debug({ err, lockPath }, "lock file not readable");
        return null;
    }
}

export function dbBytes(dbPath: string): number {
    let total = 0;
    for (const suffix of ["", "-wal"]) {
        try {
            total += statSync(`${dbPath}${suffix}`).size;
        } catch (err) {
            log.debug({ err, file: `${dbPath}${suffix}` }, "no file to size");
        }
    }

    return total;
}

/** `meta.schema_version`, or null when the database has no meta table yet. */
export function readSchemaVersion(db: Database): number | null {
    const table = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
    if (!table) {
        return null;
    }

    const row = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get();
    return row ? Number(row.value) : null;
}

function assertSchemaSupported(db: Database, path: string): void {
    const version = readSchemaVersion(db);
    if (version !== null && version > SCHEMA_VERSION) {
        db.close();
        throw new IndexError(
            "schema_newer",
            `${path} has schema version ${version}; this tool reads version ${SCHEMA_VERSION}. Update GenesisTools.`
        );
    }
}

/**
 * The writer connection: WAL so readers (the Genesis app) keep seeing the last
 * committed snapshot while a build runs, and every DDL through runMigrations.
 * The version check runs BEFORE the migrations, so a newer database is never
 * touched by an older tool.
 */
export function openIndexDbForWrite(path: string): Database {
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path, { create: true });
    applyPragmas(db, { journalMode: "WAL", busyTimeoutMs: 5000, synchronous: "NORMAL", foreignKeys: false });
    assertSchemaSupported(db, path);
    runMigrations(db, INDEX_MIGRATIONS, MIGRATION_SCOPE);
    log.debug({ path }, "index db opened for write");
    return db;
}

/** A read-only connection for `query` and `diff`. A missing database is `not_built`. */
export function openIndexDbForRead(path: string): Database {
    if (!existsSync(path)) {
        throw new IndexError("not_built", `No index at ${path}. Run \`${toolCommand("du index build")}\` first.`);
    }

    const db = new Database(path, { readonly: true });
    applyPragmas(db, { busyTimeoutMs: 5000 }, true);
    assertSchemaSupported(db, path);
    if (readSchemaVersion(db) === null) {
        db.close();
        throw new IndexError("not_built", `${path} is not a du index (no meta table).`);
    }

    log.debug({ path }, "index db opened read-only");
    return db;
}

export function getMeta(db: Database, key: string): string | null {
    const row = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? row.value : null;
}

export function setMeta(db: Database, key: string, value: string): void {
    db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
        key,
        value,
    ]);
}

export function allMeta(db: Database): Record<string, string> {
    const rows = db.query<{ key: string; value: string }, []>("SELECT key, value FROM meta ORDER BY key").all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** A du run is a Bun process (the CLI, the daemon task) or the clonesize binary. */
function isDuRunCommand(command: string): boolean {
    return /\bbun\b|clonesize/.test(command);
}

/**
 * True when the du run that recorded `pid` (in `scans.pid`, or a temp file's name)
 * is over: no process has the pid any more, or another program reuses it. A pid
 * whose command line the OS will not tell counts as still running.
 */
export function duRunGone(pid: number): boolean {
    const status = classifyPid(pid, isDuRunCommand).status;
    return status === "dead" || status === "foreign";
}

/** Marks `running` scans whose process is gone as `aborted`, so the history never claims a dead run is live. */
export function sweepDeadScans(db: Database, now: number): number {
    const running = db
        .query<{ id: number; pid: number | null }, []>("SELECT id, pid FROM scans WHERE status = 'running'")
        .all();
    let swept = 0;
    for (const r of running) {
        if (r.pid !== null && r.pid !== process.pid && duRunGone(r.pid)) {
            db.run("UPDATE scans SET status = 'aborted', finished_at_ms = ? WHERE id = ?", [now, r.id]);
            swept++;
        }
    }

    return swept;
}
