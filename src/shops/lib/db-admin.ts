import { statSync } from "node:fs";
import { type ShopsDatabase, getShopsDatabase } from "../db/ShopsDatabase";

export interface MigrationRow {
    id: string;
    applied_at: number;
    ms: number;
}

export function listMigrations(db: ShopsDatabase = getShopsDatabase()): MigrationRow[] {
    return db
        .raw()
        .query<MigrationRow, []>(`SELECT id, applied_at, ms FROM _migrations ORDER BY applied_at`)
        .all();
}

export interface DbTableInfo {
    name: string;
    rows: number;
}

export interface DbInfo {
    path: string;
    sizeBytes: number | null;
    tables: DbTableInfo[];
}

export function getDbInfo(db: ShopsDatabase = getShopsDatabase()): DbInfo {
    const path = db.path();
    let sizeBytes: number | null = null;
    try {
        sizeBytes = statSync(path).size;
    } catch {
        sizeBytes = null;
    }

    const tables = db
        .raw()
        .query<{ name: string }, []>(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'products_fts%' ORDER BY name`
        )
        .all();

    const counted: DbTableInfo[] = tables.map((t) => {
        const c = db.raw().query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM ${t.name}`).get();
        return { name: t.name, rows: c?.c ?? 0 };
    });

    return { path, sizeBytes, tables: counted };
}

export function vacuumDb(db: ShopsDatabase = getShopsDatabase()): void {
    db.raw().exec("VACUUM");
}
