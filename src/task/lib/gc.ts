import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@app/logger";
import { getTaskSessionsDir } from "@app/task/lib/paths";
import { isProcessAlive } from "@app/task/lib/process-alive";
import { TaskSessionStore } from "@app/task/lib/session-store";

export async function runSessionGc(opts: { retentionDays: number }): Promise<{ removed: number }> {
    const cutoffMs = Date.now() - opts.retentionDays * 24 * 3600 * 1000;
    const dir = getTaskSessionsDir();
    let names: string[];

    try {
        names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl") && !n.endsWith(".ui.jsonl"));
    } catch (err) {
        logger.warn({ err, dir }, "gc: failed to read sessions directory");

        return { removed: 0 };
    }

    let removed = 0;
    const store = new TaskSessionStore();

    for (const file of names) {
        const session = file.replace(/\.jsonl$/, "");

        try {
            const st = await stat(join(dir, file));
            if (st.mtimeMs >= cutoffMs) {
                continue;
            }

            const meta = await store.reconcileSessionState(session);
            if (meta?.exitCode === undefined && meta?.pid !== undefined && isProcessAlive(meta.pid)) {
                continue;
            }

            await store.deleteSession(session);
            removed++;
            logger.debug({ session, age: Date.now() - st.mtimeMs }, "gc: removed session");
        } catch (err) {
            logger.warn({ err, session }, "gc: failed to evaluate session");
        }
    }

    return { removed };
}
