import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { scanWithCFfi } from "@app/du/lib/engine";
import { detectWorktreeExcludes } from "@app/du/lib/worktrees";
import { canonicalWorktreePath } from "@genesiscz/utils/git/worktrees";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage";

const log = logger.child({ component: "hub/worktrees" });

export interface WorktreeSize {
    path: string;
    /** Clone-deduplicated allocated bytes inside the worktree (what `tools du` reports). */
    bytes: number;
    /** The floor of what removing it frees: bytes no clone elsewhere shares. */
    freeableBytes: number | null;
    files: number;
    elapsedMs: number;
    error?: string;
}

/**
 * One clone-aware scan per worktree through the `tools du` C core (bun:ffi, its own threads).
 * Other worktrees nested inside are excluded. Scans run sequentially to avoid competing for disk I/O.
 * Each scan requests half the available parallelism, with a minimum of two threads.
 */
export async function worktreeSizes(paths: string[]): Promise<WorktreeSize[]> {
    const storage = new Storage("du");
    await storage.ensureDirs();
    const cacheDir = storage.getCacheDir();
    const sizes: WorktreeSize[] = [];

    for (const given of paths) {
        const path = canonicalWorktreePath(given);
        const started = performance.now();

        if (!existsSync(path)) {
            // The du core reports an empty tree for a missing folder: 0 bytes would read as measured.
            sizes.push({
                path,
                bytes: 0,
                freeableBytes: null,
                files: 0,
                elapsedMs: 0,
                error: "The folder does not exist",
            });
            continue;
        }

        try {
            const exclude = await detectWorktreeExcludes(path);
            // Half the cores: the hub keeps drawing (and agents keep building) while sizes fill in.
            const threads = Math.max(2, Math.floor(availableParallelism() / 2));
            const result = scanWithCFfi({ path, exclude, freeable: true, cacheDir, threads });
            sizes.push({
                path,
                bytes: result.unique_allocated_bytes ?? result.unique_bytes,
                freeableBytes: result.private_sum_bytes ?? null,
                files: result.files_scanned,
                elapsedMs: Math.round(performance.now() - started),
            });
        } catch (err) {
            log.warn({ err, path }, "worktree size scan failed");
            sizes.push({
                path,
                bytes: 0,
                freeableBytes: null,
                files: 0,
                elapsedMs: Math.round(performance.now() - started),
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    log.info({ count: sizes.length, ms: sizes.map((s) => s.elapsedMs) }, "worktree sizes");
    return sizes;
}
