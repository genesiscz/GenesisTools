import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { sendInboxMessage } from "@app/question/lib/message";
import { toolCommand } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { sendNotification } from "@genesiscz/utils/macos/notifications";
import { agentDisplayName, type RmNotifyOnRequest, type RmRequest, rmDataDir } from "@genesiscz/utils/rm";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import type { RunContext } from "./run";

/** One post per asking session in this window: a burst of requests is one ping, and the picker shows them all. */
export const RM_NOTIFY_WINDOW_MS = 10 * 60_000;

export interface RequestNotice {
    title: string;
    text: string;
}

export interface NotifyDeps {
    /** Delivers one notice the way the person picked; tests replace it. */
    send: (mode: Exclude<RmNotifyOnRequest, "none">, notice: RequestNotice) => Promise<void>;
    now: () => Date;
}

const DEFAULT_NOTIFY_DEPS: NotifyDeps = { send: deliver, now: () => new Date() };

async function deliver(mode: Exclude<RmNotifyOnRequest, "none">, notice: RequestNotice): Promise<void> {
    if (mode === "notification") {
        await sendNotification({ title: notice.title, message: notice.text, group: "tools-rm-requests" });
        return;
    }

    await sendInboxMessage({ text: notice.text, title: notice.title, source: "cli" });
}

interface NotifyState {
    at: string;
    requestId: string;
}

function statePath(sessionId: string): string {
    return rmDataDir("notify", `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

function readState(path: string): NotifyState | null {
    if (!existsSync(path)) {
        return null;
    }

    try {
        const parsed: unknown = SafeJSON.parse(readFileSync(path, "utf8"));

        if (typeof parsed === "object" && parsed !== null && "at" in parsed && typeof parsed.at === "string") {
            return { at: parsed.at, requestId: "requestId" in parsed ? String(parsed.requestId) : "" };
        }
    } catch (error) {
        logger.debug({ path, error }, "rm: unreadable notify state");
    }

    return null;
}

/** The notice for a new request: who asks, how many items, where they wait, and the command that opens it. */
export function requestNotice(request: RmRequest): RequestNotice {
    const caller = request.caller;
    const agent = caller ? agentDisplayName(caller.agent) : "Someone";
    const where = [
        caller?.project ? `in ${caller.project}` : "",
        caller?.sessionTitle ? `(${caller.sessionTitle})` : "",
    ]
        .filter(Boolean)
        .join(" ");
    const count = request.targets.length;
    const aside = request.targets.every((target) => target.stored) ? ", set aside" : "";
    return {
        title: `${toolCommand("rm")} request ${request.id}`,
        text:
            `${agent}${where ? ` ${where}` : ""} asks to delete ${count} item${count === 1 ? "" : "s"}${aside}. ` +
            `Review: ${toolCommand("rm")} approve ${request.id}`,
    };
}

/**
 * Tells the person a new request waits, the way `notify.onRequest` says (default: the GenesisTools inbox), at most
 * once per asking session in RM_NOTIFY_WINDOW_MS. It only names the command: no window opens by itself, so no Touch
 * ID panel appears while the person expects another prompt. A failure is logged and never fails the run.
 */
export async function notifyNewRequest(
    request: RmRequest,
    ctx: RunContext,
    deps: NotifyDeps = DEFAULT_NOTIFY_DEPS
): Promise<void> {
    const mode = ctx.base.notify.onRequest;
    const caller = request.caller;

    if (mode === "none" || !caller?.isInAgent) {
        return;
    }

    const path = statePath(caller.sessionId ?? `no-session-${caller.agent}`);
    const now = deps.now();
    const last = readState(path);

    if (last && now.getTime() - Date.parse(last.at) < RM_NOTIFY_WINDOW_MS) {
        logger.debug({ request: request.id, last }, "rm: a request notice went to this session recently");
        return;
    }

    try {
        await deps.send(mode, requestNotice(request));
        mkdirSync(dirname(path), { recursive: true });
        atomicWriteFileSync(path, `${SafeJSON.stringify({ at: now.toISOString(), requestId: request.id })}\n`);
        logger.debug({ request: request.id, mode }, "rm: told the person about a new request");
    } catch (error) {
        logger.warn({ request: request.id, mode, error }, "rm: could not tell the person about a new request");
    }
}
