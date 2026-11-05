import { loadPins } from "@genesiscz/utils/agent-sessions/pins";
import { logger } from "@genesiscz/utils/logger";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { showT3Thread, t3AppLink } from "./thread-cli";

const { log } = logger.scoped("t3code:thread");

/**
 * The T3 Code thread a session runs in, from its newest pin (`session-pins.jsonl`, written by the SessionStart hook
 * with the `T3CODE_THREAD_ID` T3 Code gives its agent). The newest pin decides: a session resumed later in a terminal
 * pins again with no host, so it no longer names the thread. Undefined for a session no T3 thread ran.
 */
export async function t3ThreadOfSession(sessionId: string): Promise<string | undefined> {
    const pin = (await loadPins({ readOnly: true })).get(sessionId);
    return pin?.host?.kind === "t3" && pin.host.id ? pin.host.id : undefined;
}

export type T3ThreadOpen = { opened: true; title: string; link: string } | { opened: false; reason: string };

/**
 * Opens the T3 Code thread a session runs in, in the T3 Code app. Undefined when no T3 thread ran the session, so the
 * caller looks for its terminal instead.
 */
export async function openT3ThreadOfSession(sessionId: string): Promise<T3ThreadOpen | undefined> {
    const threadId = await t3ThreadOfSession(sessionId);
    if (!threadId) {
        return undefined;
    }

    const shown = await showT3Thread(threadId);
    if ("reason" in shown) {
        return { opened: false, reason: `its T3 Code thread could not be read: ${shown.reason}` };
    }

    const link = shown.thread.link ? t3AppLink(shown.thread.link) : undefined;
    if (!link) {
        return { opened: false, reason: "T3 Code printed no link for its thread" };
    }

    const opened = await boundedCommand({ command: ["open", link], timeoutMs: 10_000 });
    if (opened.status !== 0) {
        log.warn({ link, status: opened.status, stderr: opened.stderr }, "could not open a T3 Code thread");
        return { opened: false, reason: `open failed: ${opened.stderr.trim() || `exit ${opened.status}`}` };
    }

    log.info({ sessionId, threadId }, "opened the session's T3 Code thread");
    return { opened: true, title: shown.thread.title, link };
}
