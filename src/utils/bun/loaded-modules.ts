import { statSync } from "node:fs";

/**
 * Newest mtime among the modules this process loaded under `root`, in ms. A module edited after the process started
 * means it runs old code: a resident server (the hub server, a hosted MCP server) drains and the next call starts the
 * new code. A loaded module that was deleted counts as changed.
 */
export function newestLoadedModuleMtime(root: string): number {
    let newest = 0;

    for (const path of Object.keys(require.cache)) {
        if (!path.startsWith(root)) {
            continue;
        }

        try {
            newest = Math.max(newest, statSync(path).mtimeMs);
        } catch {
            newest = Number.POSITIVE_INFINITY;
        }
    }

    return newest;
}
