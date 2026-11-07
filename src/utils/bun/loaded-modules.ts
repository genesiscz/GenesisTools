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
/** The exit status of a resident process that ends because its code changed: EX_TEMPFAIL, "start me again". */
export const CODE_CHANGED_EXIT = 75;

/**
 * Calls `onChanged` once, when a module this process loaded under `root` changed after `startedAt` and then read the
 * same at two checks in a row. A checkout or a rebase writes many files over seconds, and a restart in the middle
 * would load half of them; one quiet interval lets it finish. Checks every `everyMs` on a timer that does not keep the
 * process alive. Returns the function that stops the checks.
 */
export function onLoadedCodeChange({
    root,
    startedAt,
    onChanged,
    everyMs = 15_000,
    newest = newestLoadedModuleMtime,
}: {
    root: string;
    startedAt: number;
    onChanged: () => void;
    everyMs?: number;
    /** Tests: the newest mtime of the loaded modules. */
    newest?: (root: string) => number;
}): () => void {
    let previous: number | undefined;
    const timer = setInterval(() => {
        const now = newest(root);
        const settled = now > startedAt && now === previous;
        previous = now;

        if (settled) {
            clearInterval(timer);
            onChanged();
        }
    }, everyMs);
    timer.unref();

    return () => clearInterval(timer);
}
