import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { RUN_LOG_RE, taskLogDirName } from "./run-log-name";
import type { RunLogRetention } from "./types";

/** One prune per task directory at a time: a later call joins the running one instead of racing its unlinks. */
const inFlight = new Map<string, Promise<number>>();

function runLogEpoch(filename: string): number | null {
    const m = filename.match(RUN_LOG_RE);

    if (!m) {
        return null;
    }

    // Local time, so no `Z`.
    const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}`);
    return Number.isFinite(t) ? t : null;
}

function isMissing(err: unknown): boolean {
    return err instanceof Error && "code" in err && err.code === "ENOENT";
}

async function pruneDir(taskDir: string, taskName: string, policy: RunLogRetention): Promise<number> {
    let names: string[];

    try {
        names = await readdir(taskDir);
    } catch (err) {
        if (isMissing(err)) {
            return 0;
        }

        throw err;
    }

    const files = names
        .filter((f) => RUN_LOG_RE.test(f))
        .sort()
        .reverse(); // newest-first

    if (files.length <= policy.minRuns) {
        return 0;
    }

    const cutoff = Date.now() - policy.maxAgeDays * 86_400_000;
    let deleted = 0;

    for (let i = policy.minRuns; i < files.length; i++) {
        const file = files[i];
        const epoch = runLogEpoch(file);

        if (epoch === null || epoch >= cutoff) {
            continue;
        }

        try {
            const full = join(taskDir, file);

            if ((await stat(full)).isFile()) {
                await unlink(full);
                deleted++;
            }
        } catch (err) {
            logger.warn({ err, file, taskName }, "retention: failed to delete run log");
        }
    }

    if (deleted > 0) {
        logger.info({ taskName, deleted, kept: files.length - deleted }, "retention: pruned run logs");
    }

    return deleted;
}

/**
 * Delete a task's run logs that are BOTH beyond the newest `minRuns` AND older
 * than `maxAgeDays`. Never deletes when total <= minRuns. Filename-timestamp
 * based — never opens a file. Only unlinks files matching RUN_LOG_RE inside
 * the task dir. Resolves to the number deleted.
 *
 * Every filesystem call is awaited, so the daemon's event loop keeps running while a slow disk answers: the
 * synchronous version held the scheduler for 51 s and 80 s on 2026-10-10 while it deleted five files.
 */
export function pruneTaskRunLogs(logsBaseDir: string, taskName: string, policy: RunLogRetention): Promise<number> {
    const taskDir = join(logsBaseDir, taskLogDirName(taskName));
    const running = inFlight.get(taskDir);

    if (running) {
        return running;
    }

    const prune = pruneDir(taskDir, taskName, policy).finally(() => inFlight.delete(taskDir));
    inFlight.set(taskDir, prune);
    return prune;
}
