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

    if (!readonly && merged.journalMode) {
        db.exec(`PRAGMA journal_mode = ${merged.journalMode};`);
    }

    if (typeof merged.busyTimeoutMs === "number") {
        db.exec(`PRAGMA busy_timeout = ${merged.busyTimeoutMs};`);
    }

    if (merged.foreignKeys !== undefined) {
        db.exec(`PRAGMA foreign_keys = ${merged.foreignKeys ? "ON" : "OFF"};`);
    }

    if (merged.synchronous) {
        db.exec(`PRAGMA synchronous = ${merged.synchronous};`);
    }
}
