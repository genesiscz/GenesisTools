import * as SQLite from "expo-sqlite";

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

const MIGRATIONS: string[] = [
    `CREATE TABLE IF NOT EXISTS pulse_history (
        metric TEXT NOT NULL, ts INTEGER NOT NULL, value REAL NOT NULL,
        PRIMARY KEY (metric, ts)
    );`,
    `CREATE TABLE IF NOT EXISTS qa_entries (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL
    );`,
];

export function getDb(): Promise<SQLite.SQLiteDatabase> {
    dbPromise ??= (async () => {
        const db = await SQLite.openDatabaseAsync("devdashboard.db");
        await db.execAsync("PRAGMA journal_mode = WAL;");

        for (const stmt of MIGRATIONS) {
            await db.execAsync(stmt);
        }

        return db;
    })();

    return dbPromise;
}
