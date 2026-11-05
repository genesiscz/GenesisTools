import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { t3Home } from "@genesiscz/utils/t3code/thread-env";

const { log } = logger.scoped("t3code:threads");
const prof = profiler.scope("agent-context");

/** How long the read may wait on a T3 server mid-checkpoint: a session listing must not. */
const LOOKUP_BUDGET_MS = 150;

/** The thread that started a T3 Code thread, and T3's word for how they relate ("subagent" for `delegate_task`). */
export interface T3ThreadParent {
    id: string;
    relationship: string | null;
}

/** The T3 Code thread that runs one native session, and its parent when another thread started it. */
export interface T3SessionThread {
    threadId: string;
    parent: T3ThreadParent | null;
}

interface ThreadRow {
    nativeId: string | null;
    threadId: string;
    parentThreadId: string | null;
    relationship: string | null;
}

/**
 * Every T3 Code thread that runs a native session (a Codex rollout id, a Claude session id), by that id, from T3's own
 * state database: `orchestration_v2_projection_provider_threads` names the native id, and the thread's lineage says
 * which thread started it (a `delegate_task` sub-agent). A Codex session T3 starts writes no SessionStart pin, so this
 * is the only record that it runs in T3 at all (2026-11-05: a "Cache critical" banner for each review sub-agent).
 *
 * One read-only query over every thread (202 threads in 1.5 to 2.7 ms, 2026-11-05), opened with `query_only` and a
 * busy budget, never in immutable mode (the server writes it live, in WAL mode). A missing file, a lock or a changed
 * schema answers an empty map, logged, never a guess. Local only: no server, no network.
 */
export function t3SessionThreads(homeDir: string = t3Home(env.getProcessEnv())): Map<string, T3SessionThread> {
    const path = join(homeDir, "userdata", "statev2.sqlite");
    const threads = new Map<string, T3SessionThread>();

    if (!existsSync(path)) {
        log.debug({ path }, "t3code: no T3 Code state database, so no session runs in a T3 thread");
        return threads;
    }

    return prof.measure("t3code.sessionThreads", () => {
        let db: Database | undefined;

        try {
            db = new Database(path, { readonly: true });
            db.exec(`PRAGMA busy_timeout = ${LOOKUP_BUDGET_MS}`);
            db.exec("PRAGMA query_only = ON");
            const rows = db
                .query<ThreadRow, []>(
                    `SELECT json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') AS nativeId,
                            pt.thread_id AS threadId,
                            json_extract(t.payload_json, '$.lineage.parentThreadId') AS parentThreadId,
                            json_extract(t.payload_json, '$.lineage.relationshipToParent') AS relationship
                       FROM orchestration_v2_projection_provider_threads pt
                       LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = pt.thread_id
                      WHERE json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') IS NOT NULL`
                )
                .all();

            for (const row of rows) {
                if (!row.nativeId) {
                    continue;
                }

                threads.set(row.nativeId, {
                    threadId: row.threadId,
                    parent: row.parentThreadId ? { id: row.parentThreadId, relationship: row.relationship } : null,
                });
            }

            log.debug({ path, threads: threads.size }, "t3code: read the T3 Code threads of native sessions");
            return threads;
        } catch (error) {
            log.debug({ error, path }, "t3code: the T3 Code thread lookup failed; no row is marked as a T3 thread");
            return new Map();
        } finally {
            db?.close();
        }
    });
}
