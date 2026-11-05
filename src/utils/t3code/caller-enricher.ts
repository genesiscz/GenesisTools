import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CallerHost, ContextEnricher } from "@genesiscz/utils/agent/identity/types";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { readT3Thread, T3_CALLER_ENV_KEYS, t3Home } from "@genesiscz/utils/t3code/thread-env";

const { log } = logger.scoped("agent-context");
const prof = profiler.scope("agent-context");

/**
 * How long the thread lookup may wait on a locked database. The read is one indexed row; a T3 server mid-checkpoint
 * is the only thing that makes it wait, and a caller's log line must not.
 */
const LOOKUP_BUDGET_MS = 150;

interface ThreadRow {
    instance: string | null;
    model: string | null;
    projectId: string | null;
    projectRoot: string | null;
    parentThreadId: string | null;
    relationship: string | null;
}

/**
 * The thread's provider instance, model, project and parent, from T3 Code's own state database. The cheapest
 * read-only path the research found (one indexed SQLite read; the `t3 thread show` CLI took 258 ms, and the MCP
 * `t3_thread_read` can mark a child's result delivered, a side effect). Opened read-only with `query_only`, never in
 * immutable mode (the server writes it live, in WAL mode), with a busy budget; a missing file, a lock, a changed
 * schema or an unknown thread all answer undefined, logged, never a guess. Local only: no server, no network.
 */
export function readT3ThreadDetails(threadId: string, homeDir: string): Partial<CallerHost> | undefined {
    const path = join(homeDir, "userdata", "statev2.sqlite");

    if (!existsSync(path)) {
        log.debug({ path }, "agent-context: no T3 Code state database for the thread lookup");
        return undefined;
    }

    return prof.measure("t3code.threadDetails", () => {
        let db: Database | undefined;

        try {
            db = new Database(path, { readonly: true });
            db.exec(`PRAGMA busy_timeout = ${LOOKUP_BUDGET_MS}`);
            db.exec("PRAGMA query_only = ON");
            const row = db
                .query<ThreadRow, [string]>(
                    `SELECT t.provider_instance_id AS instance,
                            json_extract(t.payload_json, '$.modelSelection.model') AS model,
                            t.project_id AS projectId,
                            p.workspace_root AS projectRoot,
                            json_extract(t.payload_json, '$.lineage.parentThreadId') AS parentThreadId,
                            json_extract(t.payload_json, '$.lineage.relationshipToParent') AS relationship
                       FROM orchestration_v2_projection_threads t
                       LEFT JOIN projection_projects p ON p.project_id = t.project_id
                      WHERE t.thread_id = ?`
                )
                .get(threadId);

            if (!row) {
                log.debug({ path }, "agent-context: the T3 Code state database does not know the caller's thread");
                return undefined;
            }

            return {
                providerInstanceId: row.instance,
                model: row.model,
                projectId: row.projectId,
                projectRoot: row.projectRoot,
                parentThreadId: row.parentThreadId,
                relationshipToParent: row.relationship,
            };
        } catch (error) {
            log.debug({ error, path }, "agent-context: the T3 Code thread lookup failed; the host stays the thread id");
            return undefined;
        } finally {
            db?.close();
        }
    });
}

/** The T3 Code host of a caller: the thread id for free, its details only for the `host` facet. */
export const t3codeCallerEnricher: ContextEnricher<"t3code"> = {
    id: "t3code",
    envKeys: () => T3_CALLER_ENV_KEYS,
    enrich: ({ env, facets }) => {
        const threadId = readT3Thread(env);

        if (!threadId) {
            return undefined;
        }

        const details = facets.has("host") ? readT3ThreadDetails(threadId, t3Home(env)) : undefined;
        return { app: "t3code", threadId, ...details };
    },
};
