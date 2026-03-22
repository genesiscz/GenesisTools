import { IndexerManager } from "../lib/manager";

let manager: IndexerManager | null = null;
let managerPromise: Promise<IndexerManager> | null = null;

/** Lazy-init singleton IndexerManager. Reused across all tool handlers. */
export async function getManager(): Promise<IndexerManager> {
    if (manager) {
        return manager;
    }

    if (!managerPromise) {
        managerPromise = IndexerManager.load().then((m) => {
            manager = m;
            managerPromise = null;
            return m;
        });
    }

    return managerPromise;
}

/** Graceful shutdown: close all open indexers. */
export async function shutdownManager(): Promise<void> {
    if (manager) {
        await manager.close();
        manager = null;
    }
}

/** Format an error into a user-friendly MCP response string. */
export function formatError(action: string, err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error during ${action}: ${msg}`;
}
