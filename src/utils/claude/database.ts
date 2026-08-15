import { join } from "node:path";
import { BaseDatabase } from "@genesiscz/utils/database";
import { env } from "@genesiscz/utils/env";

/**
 * Resolved the same way `Storage` resolves its root, and resolved LAZILY.
 *
 * This was a module-level `const` over a bare `homedir()`, which put it outside
 * the test sandbox twice over: it ignored `GENESIS_TOOLS_HOME`, and being a
 * const it would have captured the value at import time anyway, before the
 * preload could set it. A Phase 8c test that constructed `UsageHistoryDb()`
 * with no path therefore wrote three fixture rows into the real
 * ~/.genesis-tools/claude-history/index.db, alongside 35k genuine ones.
 */
function claudeDbPath(): string {
    return join(env.tools.getHome(), ".genesis-tools", "claude-history", "index.db");
}

let _instance: ClaudeDatabase | null = null;

export class ClaudeDatabase extends BaseDatabase {
    constructor(dbPath: string = claudeDbPath()) {
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
