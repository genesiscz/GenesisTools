import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { appPathForBundleId } from "@genesiscz/utils/macos/launch-services";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { profiler } from "@genesiscz/utils/profile";

const { log } = logger.scoped("t3code:place");
const prof = profiler.scope("agent-context");

/** How long the read may wait on a T3 server mid-checkpoint: a session window must not. */
const LOOKUP_BUDGET_MS = 150;

/** The T3 Code desktop app (`/Applications/T3 Code (Beta).app`). */
export const T3_APP_BUNDLE_ID = "com.t3tools.t3code";

/**
 * The run states T3 Code counts as unfinished: its own recovery index lists them
 * (`orchestration_v2_projection_runs_recovery_idx` in statev2.sqlite).
 */
const LIVE_RUN_STATES = ["queued", "preparing", "starting", "running", "waiting"] as const;

/** One T3 Code thread as the session host needs it: its title, whether it is gone, and whether a turn runs now. */
export interface T3ThreadPlace {
    threadId: string;
    title: string | null;
    archived: boolean;
    deleted: boolean;
    /** A run of the thread is queued or in progress (T3 Code's run table), so the agent works now. */
    live: boolean;
}

interface PlaceRow {
    title: string | null;
    archivedAt: string | null;
    deletedAt: string | null;
    live: number;
}

/**
 * The id T3 Code gives this machine's environment: the first part of every desktop thread link. T3 Code writes it to
 * `<home>/userdata/environment-id` at its first start. Undefined when T3 Code never ran here.
 */
export function t3EnvironmentId(homeDir: string): string | undefined {
    const path = join(homeDir, "userdata", "environment-id");

    try {
        const id = readFileSync(path, "utf8").trim();
        return id || undefined;
    } catch (error) {
        log.debug({ error, path }, "t3code: no environment id, so no desktop link");
        return undefined;
    }
}

/**
 * The desktop app's link to a thread: `t3code://threads/<environment>/<thread>`, the thread id percent-encoded
 * (`promptLinkAppPath` in T3 Code's packages/shared/src/promptLinks.ts). Never the `http://127.0.0.1:3773/…` link: a
 * browser that is not paired with the environment shows a pairing page instead of the thread.
 */
export function t3ThreadDesktopLink({ environmentId, threadId }: { environmentId: string; threadId: string }): string {
    return `t3code://threads/${environmentId}/${encodeURIComponent(threadId)}`;
}

/**
 * One thread's title, archive and delete marks, and whether a run is live, from T3 Code's state database. Opened
 * read-only with `query_only` and a busy budget, never immutable (the server writes it live, in WAL mode). A missing
 * file, a lock, a changed schema or an unknown thread answer undefined, logged, never a guess.
 */
export function readT3ThreadPlace(threadId: string, homeDir: string): T3ThreadPlace | undefined {
    const path = join(homeDir, "userdata", "statev2.sqlite");

    if (!existsSync(path)) {
        log.debug({ path }, "t3code: no T3 Code state database for the thread place");
        return undefined;
    }

    return prof.measure("t3code.threadPlace", () => {
        let db: Database | undefined;

        try {
            db = new Database(path, { readonly: true });
            db.exec(`PRAGMA busy_timeout = ${LOOKUP_BUDGET_MS}`);
            db.exec("PRAGMA query_only = ON");
            const states = LIVE_RUN_STATES.map(() => "?").join(", ");
            const row = db
                .query<PlaceRow, string[]>(
                    `SELECT json_extract(t.payload_json, '$.title') AS title,
                            json_extract(t.payload_json, '$.archivedAt') AS archivedAt,
                            json_extract(t.payload_json, '$.deletedAt') AS deletedAt,
                            EXISTS (SELECT 1 FROM orchestration_v2_projection_runs r
                                     WHERE r.thread_id = t.thread_id AND r.status IN (${states})) AS live
                       FROM orchestration_v2_projection_threads t
                      WHERE t.thread_id = ?`
                )
                .get(...LIVE_RUN_STATES, threadId);

            if (!row) {
                log.debug({ path, threadId }, "t3code: the state database does not know the thread");
                return undefined;
            }

            return {
                threadId,
                title: row.title || null,
                archived: Boolean(row.archivedAt),
                deleted: Boolean(row.deletedAt),
                live: row.live === 1,
            };
        } catch (error) {
            log.debug({ error, path, threadId }, "t3code: the thread place lookup failed");
            return undefined;
        } finally {
            db?.close();
        }
    });
}

/** Whether the T3 Code desktop app is installed here (Launch Services, the lookup `open -b` uses). */
export function t3AppInstalled(): boolean {
    return appPathForBundleId(T3_APP_BUNDLE_ID) !== null;
}

export type T3AppOpen = { opened: true } | { opened: false; reason: string };

/**
 * Opens a desktop thread link in T3 Code. `open -b` names the app, so T3 Code comes forward (a bare `open <link>`
 * switches the thread but can leave T3 Code behind the front app); `activate: false` adds `-g` and leaves it behind.
 */
export async function openT3DesktopLink({
    link,
    activate = true,
}: {
    link: string;
    activate?: boolean;
}): Promise<T3AppOpen> {
    const command = ["open", ...(activate ? [] : ["-g"]), "-b", T3_APP_BUNDLE_ID, link];
    const result = await boundedCommand({ command, timeoutMs: 10_000 });

    if (result.status !== 0) {
        log.warn({ link, status: result.status, stderr: result.stderr }, "t3code: could not open a thread link");
        return { opened: false, reason: `open failed: ${result.stderr.trim() || `exit ${result.status}`}` };
    }

    log.info({ link, activate }, "t3code: opened a thread in T3 Code");
    return { opened: true };
}
