import { homedir } from "node:os";
import { join } from "node:path";
import { BaseDatabase } from "@app/utils/database";

const CLAUDE_DB_PATH = join(homedir(), ".genesis-tools", "claude-history", "index.db");

let _instance: ClaudeDatabase | null = null;

export class ClaudeDatabase extends BaseDatabase {
    constructor(dbPath: string = CLAUDE_DB_PATH) {
        super(dbPath);
    }

    protected initSchema(): void {
        // Base schema — individual modules add their own tables
    }

    static getInstance(dbPath?: string): ClaudeDatabase {
        if (!_instance) {
            _instance = new ClaudeDatabase(dbPath);
        }

        return _instance;
    }

    static closeInstance(): void {
        _instance?.close();
        _instance = null;
    }
}
