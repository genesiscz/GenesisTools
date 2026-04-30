import { homedir } from "node:os";
import { join } from "node:path";
import { createKyselyClient, type DatabaseClient } from "@app/utils/database";
import type { AskDB } from "./db-types";

const BOOTSTRAP: string[] = [
    `CREATE TABLE IF NOT EXISTS usage_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0,
        timestamp TEXT NOT NULL,
        message_index INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_session_id ON usage_records(session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_timestamp ON usage_records(timestamp)`,
    `CREATE INDEX IF NOT EXISTS idx_provider_model ON usage_records(provider, model)`,
    `CREATE INDEX IF NOT EXISTS idx_date ON usage_records(date(timestamp))`,
];

export function defaultAskDbPath(): string {
    return join(homedir(), ".genesis-tools", "ask.sqlite");
}

export function openAskDatabase(path?: string): DatabaseClient<AskDB> {
    return createKyselyClient<AskDB>({
        path: path ?? defaultAskDbPath(),
        bootstrap: BOOTSTRAP,
    });
}

let singleton: DatabaseClient<AskDB> | null = null;

export function getAskDatabase(): DatabaseClient<AskDB> {
    if (!singleton) {
        singleton = openAskDatabase();
    }

    return singleton;
}
