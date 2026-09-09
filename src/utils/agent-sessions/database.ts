import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BaseDatabase } from "@genesiscz/utils/database/base";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";

export function historyDatabasePath(): string {
    return join(env.tools.getHome(), ".genesis-tools", "claude-history", "index.db");
}

/** The caller owns this read-only handle. No migrations or directory creation occur. */
export function openHistoryReadOnly(options: { path?: string } = {}): Database | undefined {
    const path = options.path ?? historyDatabasePath();

    if (!existsSync(path)) {
        return undefined;
    }

    logger.debug({ path }, "Opening cached history for read-only lookup");
    return new Database(path, { readonly: true });
}

function prepareHistoryPath(path: string): string {
    if (path === ":memory:") {
        return path;
    }

    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

    if (resolve(dirname(path)) === resolve(dirname(historyDatabasePath()))) {
        chmodSync(dirname(path), 0o700);
    }

    closeSync(openSync(path, "a", 0o600));
    protectHistoryFiles(path);
    return path;
}

function protectHistoryFiles(path: string): void {
    if (path === ":memory:") {
        return;
    }

    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
        try {
            chmodSync(file, 0o600);
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
                throw error;
            }
        }
    }
}

const shared = new Map<string, HistoryDatabase>();
let selectedPath: { home: string; path: string } | undefined;

/** Owns connections only; history and usage initialize their own migration scopes. */
export class HistoryDatabase extends BaseDatabase {
    constructor(private readonly path: string = historyDatabasePath()) {
        super(prepareHistoryPath(path));
        protectHistoryFiles(path);
        logger.debug({ path }, "Opened shared history database connection");
    }

    protected initSchema(): void {}

    /** Set on the process-wide instance so a borrower's close() cannot take it from the others. */
    private shared = false;

    static getInstance(dbPath?: string): HistoryDatabase {
        const home = env.tools.getHome();

        if (dbPath !== undefined) {
            selectedPath = { home, path: dbPath === ":memory:" ? dbPath : resolve(dbPath) };
        }

        const path = selectedPath?.home === home ? selectedPath.path : historyDatabasePath();
        let instance = shared.get(path);

        if (!instance) {
            instance = new HistoryDatabase(path);
            instance.shared = true;
            shared.set(path, instance);
        }

        return instance;
    }

    /**
     * Borrowing a shared handle and closing it used to end the connection for every other
     * consumer, including the usage daemon. UsageLimitsDb grew an ownsConnection flag after
     * exactly that; three other call sites carry only a comment asking not to. Ownership is
     * stated here instead: only closeInstance() ends the process-wide connection.
     */
    override close(): void {
        if (this.shared) {
            logger.debug({ path: this.path }, "Ignoring close() on the shared history connection");
            return;
        }

        super.close();
    }

    static closeInstance(): void {
        for (const instance of shared.values()) {
            instance.shared = false;
            instance.close();
        }

        shared.clear();
        selectedPath = undefined;
    }
}
