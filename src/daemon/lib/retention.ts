import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import logger from "@app/logger";
import type { RunLogRetention } from "./types";

// Matches `<safeTimestamp>-<runId>.jsonl`, e.g. 2026-05-15T19-02-16-a8a9c339.jsonl
const RUN_LOG_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-[0-9a-fA-F]+\.jsonl$/;

function runLogEpoch(filename: string): number | null {
    const m = filename.match(RUN_LOG_RE);

    if (!m) {
        return null;
    }

    const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : null;
}

/**
 * Delete a task's run logs that are BOTH beyond the newest `minRuns` AND older
 * than `maxAgeDays`. Never deletes when total <= minRuns. Filename-timestamp
 * based — never opens a file. Only unlinks files matching RUN_LOG_RE inside
 * the task dir. Returns the number deleted.
 */
export function pruneTaskRunLogs(logsBaseDir: string, taskName: string, policy: RunLogRetention): number {
    const taskDir = join(logsBaseDir, taskName);

    if (!existsSync(taskDir)) {
        return 0;
    }

    const files = readdirSync(taskDir)
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

            if (statSync(full).isFile()) {
                unlinkSync(full);
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
