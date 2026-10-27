/**
 * `resume` — release targets that a debugger client left held. Browser-level `Target.setAutoAttach` makes Chrome
 * hold every window.open() popup until `Runtime.runIfWaitingForDebugger`; a held popup pauses its renderer, and
 * its opener shows "Debugger paused in another tab". Stopping the client that held it does not release it.
 *
 * Only resume commands are sent: no evaluate, no Network or Page domain, no new tabs (Debugger only with
 * `debugger: true`), so it is safe on a browser that holds a live session.
 */

import { abortableSleep, concurrentMap } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";
import { CdpDeadlineError, type CdpEventListener, type Conn, makeMatcher } from "./cdp.ts";

const { log } = logger.scoped("chrome-devtools:resume");

export const RESUME_DEFAULT_TARGET_MS = 5000;
export const RESUME_DEFAULT_TOTAL_MS = 30_000;
const RESUME_CONCURRENCY = 8;
const STEP_MS = 2000;
const DETACH_MS = 1000;
const PAUSED_WAIT_MS = 300;
const RELEASE_WAIT_MS = 1000;
const RELEASE_POLL_MS = 200;
const PAGE_TYPES = ["page", "iframe"];
const WORKER_TYPES = ["worker", "service_worker", "shared_worker"];

export type ResumeConn = Pick<Conn, "send" | "on" | "off">;

export interface ResumeTargetInfo {
    targetId: string;
    type: string;
    url: string;
    title?: string;
    openerId?: string;
}

export type ResumeStep = "cap" | "info" | "attach" | "run" | "debugger" | "verify";

export interface ResumeRecord {
    targetId: string;
    type: string;
    url: string;
    urlAfter?: string;
    outcome: "released" | "ok" | "debugger-resumed" | "timeout" | "error";
    step?: ResumeStep;
    message?: string;
}

export interface ResumeReport {
    records: ResumeRecord[];
    timedOut: boolean;
}

export interface ResumeOpts {
    conn: ResumeConn;
    match?: string;
    workers?: boolean;
    debugger?: boolean;
    perTargetMs?: number;
    totalMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" && value ? value : undefined;
}

export function parseTargetInfos(reply: unknown): ResumeTargetInfo[] {
    const infos = isRecord(reply) && Array.isArray(reply.targetInfos) ? reply.targetInfos : [];

    return infos.flatMap((info): ResumeTargetInfo[] =>
        isRecord(info) && typeof info.targetId === "string" && typeof info.type === "string"
            ? [
                  {
                      targetId: info.targetId,
                      type: info.type,
                      url: typeof info.url === "string" ? info.url : "",
                      title: optionalString(info.title),
                      openerId: optionalString(info.openerId),
                  },
              ]
            : []
    );
}

export function isBlankUrl(url: string): boolean {
    const trimmed = url.trim();
    return trimmed === "" || trimmed === "about:blank";
}

/** A page with an empty URL and an opener: what a window.open() popup looks like while a client holds it. */
export function isPossiblyHeldPopup(t: Pick<ResumeTargetInfo, "type" | "url" | "openerId">): boolean {
    return t.type === "page" && isBlankUrl(t.url) && Boolean(t.openerId);
}

/**
 * Pages and iframes (workers with `workers`), never devtools://. With `match`, the matching targets plus the
 * held-looking popups those targets opened: a held popup has no URL, so no URL pattern can name it.
 */
export function selectResumeTargets(
    infos: ResumeTargetInfo[],
    opts: { match?: string; workers?: boolean } = {}
): ResumeTargetInfo[] {
    const types = new Set(opts.workers ? [...PAGE_TYPES, ...WORKER_TYPES] : PAGE_TYPES);
    const candidates = infos.filter((t) => types.has(t.type) && !t.url.startsWith("devtools://"));

    if (!opts.match) {
        return candidates;
    }

    const matches = makeMatcher(opts.match);
    const picked = candidates.filter((t) => matches(t.url));
    const pickedIds = new Set(picked.map((t) => t.targetId));
    const popups = candidates.filter(
        (t) => !pickedIds.has(t.targetId) && isPossiblyHeldPopup(t) && t.openerId && pickedIds.has(t.openerId)
    );

    return [...picked, ...popups];
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

async function readTargetUrl(conn: ResumeConn, targetId: string, signal: AbortSignal): Promise<string | undefined> {
    const reply = await conn.send("Target.getTargetInfo", { targetId }, undefined, { timeoutMs: STEP_MS, signal });

    if (isRecord(reply) && isRecord(reply.targetInfo) && typeof reply.targetInfo.url === "string") {
        return reply.targetInfo.url;
    }

    return undefined;
}

/** Wait up to RELEASE_WAIT_MS for a blank target to get a real URL; returns the last URL seen. */
async function waitForRealUrl(conn: ResumeConn, targetId: string, signal: AbortSignal): Promise<string> {
    const deadline = Date.now() + RELEASE_WAIT_MS;
    let url = "";

    for (;;) {
        url = (await readTargetUrl(conn, targetId, signal)) ?? url;
        const remaining = deadline - Date.now();
        if (!isBlankUrl(url) || remaining <= 0) {
            return url;
        }

        await abortableSleep(Math.min(RELEASE_POLL_MS, remaining), signal);
    }
}

/** Enable Debugger, resume a pause that shows up within PAUSED_WAIT_MS, disable. True when it resumed one. */
async function resumeDebuggerPause(conn: ResumeConn, sessionId: string, signal: AbortSignal): Promise<boolean> {
    let onPaused: () => void = () => undefined;
    const paused = new Promise<boolean>((resolve) => {
        onPaused = () => resolve(true);
    });
    const listener: CdpEventListener = (method, _params, sid) => {
        if (method === "Debugger.paused" && sid === sessionId) {
            onPaused();
        }
    };

    conn.on(listener);
    try {
        await conn.send("Debugger.enable", {}, sessionId, { timeoutMs: STEP_MS, signal });
        const sawPause = await Promise.race([paused, abortableSleep(PAUSED_WAIT_MS, signal).then(() => false)]);
        if (!sawPause) {
            return false;
        }

        try {
            await conn.send("Debugger.resume", {}, sessionId, { timeoutMs: STEP_MS, signal });
            return true;
        } catch (err) {
            if (errorMessage(err).includes("Can only perform operation while paused")) {
                return false;
            }

            throw err;
        }
    } finally {
        conn.off(listener);
        await conn.send("Debugger.disable", {}, sessionId, { timeoutMs: DETACH_MS }).catch((err: unknown) => {
            log.debug({ err, sessionId }, "Debugger.disable failed");
        });
    }
}

async function resumeOne({
    conn,
    target,
    perTargetMs,
    cap,
    useDebugger,
}: {
    conn: ResumeConn;
    target: ResumeTargetInfo;
    perTargetMs: number;
    cap: AbortSignal;
    useDebugger: boolean;
}): Promise<ResumeRecord> {
    const base = { targetId: target.targetId, type: target.type, url: target.url };

    if (cap.aborted) {
        return { ...base, outcome: "timeout", step: "cap" };
    }

    const signal = AbortSignal.any([AbortSignal.timeout(perTargetMs), cap]);
    let step: ResumeStep = "info";
    let sessionId: string | undefined;

    try {
        const before = (await readTargetUrl(conn, target.targetId, signal)) ?? target.url;

        step = "attach";
        const attached = await conn.send(
            "Target.attachToTarget",
            { targetId: target.targetId, flatten: true },
            undefined,
            {
                timeoutMs: STEP_MS,
                signal,
            }
        );
        sessionId = isRecord(attached) ? optionalString(attached.sessionId) : undefined;
        if (!sessionId) {
            return { ...base, outcome: "error", step, message: "attachToTarget returned no sessionId" };
        }

        step = "run";
        await conn.send("Runtime.runIfWaitingForDebugger", {}, sessionId, { timeoutMs: STEP_MS, signal });

        let debuggerResumed = false;
        if (useDebugger) {
            step = "debugger";
            debuggerResumed = await resumeDebuggerPause(conn, sessionId, signal);
        }

        step = "verify";
        const after = isBlankUrl(before) ? await waitForRealUrl(conn, target.targetId, signal) : before;
        const released = isBlankUrl(before) && !isBlankUrl(after);

        return {
            ...base,
            url: before,
            urlAfter: after,
            outcome: debuggerResumed ? "debugger-resumed" : released ? "released" : "ok",
        };
    } catch (err) {
        if (signal.aborted || err instanceof CdpDeadlineError) {
            return { ...base, outcome: "timeout", step: cap.aborted ? "cap" : step };
        }

        return { ...base, outcome: "error", step, message: errorMessage(err) };
    } finally {
        if (sessionId) {
            await conn
                .send("Target.detachFromTarget", { sessionId }, undefined, { timeoutMs: DETACH_MS })
                .catch((err: unknown) => {
                    log.debug({ err, sessionId }, "detachFromTarget failed");
                });
        }
    }
}

export async function runResume(opts: ResumeOpts): Promise<ResumeReport> {
    const perTargetMs = opts.perTargetMs ?? RESUME_DEFAULT_TARGET_MS;
    const cap = AbortSignal.timeout(opts.totalMs ?? RESUME_DEFAULT_TOTAL_MS);
    const reply = await opts.conn.send("Target.getTargets", {}, undefined, { timeoutMs: STEP_MS * 2, signal: cap });
    const targets = selectResumeTargets(parseTargetInfos(reply), { match: opts.match, workers: opts.workers });
    log.debug(
        { targets: targets.length, match: opts.match, workers: opts.workers, debugger: opts.debugger, perTargetMs },
        "resume: releasing targets"
    );

    const results = await concurrentMap({
        items: targets,
        concurrency: RESUME_CONCURRENCY,
        fn: (target) => resumeOne({ conn: opts.conn, target, perTargetMs, cap, useDebugger: Boolean(opts.debugger) }),
    });
    const records = targets.map(
        (t): ResumeRecord =>
            results.get(t) ?? { targetId: t.targetId, type: t.type, url: t.url, outcome: "error", message: "no result" }
    );
    log.debug({ outcomes: records.map((r) => `${r.outcome}${r.step ? `:${r.step}` : ""}`) }, "resume: done");

    return { records, timedOut: records.some((r) => r.outcome === "timeout") };
}

/** Read-only: the held-looking popups on one browser connection (doctor's check). */
export async function listPossiblyHeldPopups(
    conn: Pick<Conn, "send">,
    signal?: AbortSignal
): Promise<ResumeTargetInfo[]> {
    const reply = await conn.send("Target.getTargets", {}, undefined, { timeoutMs: 1500, signal });
    return parseTargetInfos(reply).filter(isPossiblyHeldPopup);
}
