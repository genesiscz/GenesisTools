import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { sendInboxMessage } from "@app/question/lib/message";
import { toolCommand } from "@genesiscz/utils/cli";
import { formatCount } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { sendNotification } from "@genesiscz/utils/macos/notifications";
import {
    agentDisplayName,
    type DrainFailure,
    type RmConfig,
    type RmNotifyOnRequest,
    type RmRequest,
    rmDataDir,
} from "@genesiscz/utils/rm";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
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

function writeState(path: string, state: NotifyState): void {
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, `${SafeJSON.stringify(state)}\n`);
}

/**
 * Claims the session's notice window for `requestId` under the state file's lock: the state names this request
 * BEFORE anything is sent, so a second `tools rm` of the same session that asks at the same moment finds it and stays
 * quiet. Null when a notice went out (or is going out) within the window; else the state the claim replaced.
 */
async function claimWindow(
    path: string,
    now: Date,
    requestId: string
): Promise<{ previous: NotifyState | null } | null> {
    return withFileLock(`${path}.lock`, async () => {
        const last = readState(path);

        if (last && now.getTime() - Date.parse(last.at) < RM_NOTIFY_WINDOW_MS) {
            logger.debug({ request: requestId, last }, "rm: a request notice went to this session recently");
            return null;
        }

        writeState(path, { at: now.toISOString(), requestId });
        return { previous: last };
    });
}

/** Gives the window back after a failed delivery, so the session's next request tries again; only its own claim. */
async function releaseWindow(path: string, requestId: string, previous: NotifyState | null): Promise<void> {
    await withFileLock(`${path}.lock`, async () => {
        if (readState(path)?.requestId !== requestId) {
            return;
        }

        if (previous) {
            writeState(path, previous);
            return;
        }

        unlinkSync(path);
    });
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
 * once per asking session in RM_NOTIFY_WINDOW_MS, also when several `tools rm` runs of the session ask at once (the
 * window is claimed before the send). It only names the command: no window opens by itself, so no Touch ID panel
 * appears while the person expects another prompt. A failure is logged and never fails the run; a failed delivery
 * gives the window back, so the session's next request tries again.
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
    let claim: { previous: NotifyState | null } | null;

    try {
        claim = await claimWindow(path, deps.now(), request.id);
    } catch (error) {
        logger.warn({ request: request.id, mode, error }, "rm: could not claim the request notice window");
        return;
    }

    if (!claim) {
        return;
    }

    try {
        await deps.send(mode, requestNotice(request));
        logger.debug({ request: request.id, mode }, "rm: told the person about a new request");
    } catch (error) {
        logger.warn({ request: request.id, mode, error }, "rm: could not tell the person about a new request");

        try {
            await releaseWindow(path, request.id, claim.previous);
        } catch (releaseError) {
            logger.warn({ request: request.id, error: releaseError }, "rm: could not give the notice window back");
        }
    }
}
/** The notice for a drain that could not delete everything: which batch, which paths and why, and the two ways on. */
export function drainFailureNotice(failure: DrainFailure): RequestNotice {
    const rm = toolCommand("rm");
    const count = failure.items.length;
    const shown = failure.items
        .slice(0, 3)
        .map((item) => `${item.path} (${item.reason})`)
        .join("; ");
    const more = count > 3 ? `; ${count - 3} more` : "";
    return {
        title: `${rm} could not delete ${formatCount(count, "item")}`,
        text:
            `The drain of batch ${failure.batch.id} could not delete ${shown}${more}. ` +
            `${count === 1 ? "It stays" : "They stay"} in the trash. Retry: ${rm} drain --now. ` +
            `Bring ${count === 1 ? "it" : "them"} back: ${rm} restore ${failure.batch.id}`,
    };
}

/**
 * Tells the person a drain failed, the way `notify.onFailure` says (default: the GenesisTools inbox). The drain
 * marks such a batch and leaves it for a forced drain, so this runs once per failure. A failure to tell is logged.
 */
export async function notifyDrainFailure(
    failure: DrainFailure,
    config: RmConfig,
    deps: NotifyDeps = DEFAULT_NOTIFY_DEPS
): Promise<void> {
    const mode = config.notify.onFailure;

    if (mode === "none") {
        return;
    }

    try {
        await deps.send(mode, drainFailureNotice(failure));
        logger.debug({ batch: failure.batch.id, mode }, "rm: told the person about a drain failure");
    } catch (error) {
        logger.warn({ batch: failure.batch.id, mode, error }, "rm: could not tell the person about a drain failure");
    }
}
