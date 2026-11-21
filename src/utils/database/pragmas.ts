import type { Database as BunDatabase } from "bun:sqlite";

export interface Pragmas {
    journalMode?: "WAL" | "DELETE" | "TRUNCATE" | "PERSIST" | "MEMORY" | "OFF";
    busyTimeoutMs?: number;
    foreignKeys?: boolean;
    synchronous?: "OFF" | "NORMAL" | "FULL" | "EXTRA";
}

export const DEFAULT_PRAGMAS: Required<Pick<Pragmas, "journalMode" | "busyTimeoutMs">> = {
    journalMode: "WAL",
    busyTimeoutMs: 5000,
};

export function applyPragmas(db: BunDatabase, pragmas?: Pragmas, readonly = false): void {
    const merged: Pragmas = { ...DEFAULT_PRAGMAS, ...pragmas };

    // The timeout goes first: `journal_mode` takes a lock, and without a busy handler it fails at once while
    // another connection writes ("database is locked" on the second of six parallel `tools work edit` calls).
    if (typeof merged.busyTimeoutMs === "number") {
        db.exec(`PRAGMA busy_timeout = ${merged.busyTimeoutMs};`);
    }

    if (!readonly && merged.journalMode) {
        db.exec(`PRAGMA journal_mode = ${merged.journalMode};`);
    }

    if (merged.foreignKeys !== undefined) {
        db.exec(`PRAGMA foreign_keys = ${merged.foreignKeys ? "ON" : "OFF"};`);
    }

    if (merged.synchronous) {
        db.exec(`PRAGMA synchronous = ${merged.synchronous};`);
    }
}
