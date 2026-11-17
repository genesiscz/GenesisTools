import { loadPins } from "@genesiscz/utils/agent-sessions/pins";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { t3SessionThreads, t3ThreadHolding } from "./session-threads";
import { t3Home } from "./thread-env";
import { openT3DesktopLink, readT3ThreadPlace, t3EnvironmentId, t3ThreadDesktopLink } from "./thread-place";

const { log } = logger.scoped("t3code:thread");

/**
 * The T3 Code thread a session runs in, for every agent T3 Code runs (Claude, Codex). T3 Code's own state names the
 * thread of each native session (`t3SessionThreads`); that is the only record for a Codex thread, which writes no
 * SessionStart pin. The newest pin decides as in the session list (`t3ThreadHolding`): a session resumed later in a
 * terminal pins again with no host, so it no longer names the thread. A pinned T3 thread that T3 Code's state does not
 * list (an older T3 Code, an unreadable database) still counts. Undefined for a session no T3 thread runs.
 */
export async function t3ThreadOfSession(
    sessionId: string,
    homeDir: string = t3Home(env.getProcessEnv())
): Promise<string | undefined> {
    const pin = (await loadPins({ readOnly: true })).get(sessionId);
    const held = t3ThreadHolding({ thread: t3SessionThreads(homeDir).get(sessionId), pin });

    if (held) {
        return held.threadId;
    }

    return pin?.host?.kind === "t3" && pin.host.id ? pin.host.id : undefined;
}

export type T3ThreadOpen = { opened: true; title: string; link: string } | { opened: false; reason: string };

/**
 * Opens the T3 Code thread a session runs in, in the T3 Code app, from T3 Code's local state: no server call. Undefined
 * when no T3 thread runs the session, so the caller looks for its terminal instead.
 */
export async function openT3ThreadOfSession({
    sessionId,
    activate = true,
    homeDir = t3Home(env.getProcessEnv()),
}: {
    sessionId: string;
    activate?: boolean;
    homeDir?: string;
}): Promise<T3ThreadOpen | undefined> {
    const threadId = await t3ThreadOfSession(sessionId, homeDir);
    if (!threadId) {
        return undefined;
    }

    const environmentId = t3EnvironmentId(homeDir);
    if (!environmentId) {
        return { opened: false, reason: "T3 Code has no environment id here, so the thread has no link" };
    }

    const link = t3ThreadDesktopLink({ environmentId, threadId });
    const opened = await openT3DesktopLink({ link, activate });
    if (!opened.opened) {
        return { opened: false, reason: opened.reason };
    }

    const title = readT3ThreadPlace(threadId, homeDir)?.title ?? threadId;
    log.info({ sessionId, threadId }, "opened the session's T3 Code thread");
    return { opened: true, title, link };
}
