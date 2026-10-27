/**
 * The capture engine (`record` verb). One detached process per port; attaches
 * browser-wide over CDP, auto-attaches new targets, and appends HAR-grade
 * metadata events to time-boxed segments under the capture dir.
 *
 * Origin story and the whole CPU-leak forensics: the skill reference
 * `arm-cpu-leak.md`. The load-bearing rules from that incident:
 *  - claim the pidfile BEFORE the child connects (no duplicate parsers),
 *  - never JSON.parse high-rate packets (dataReceived, ws frames),
 *  - one open fd, never appendFileSync per event,
 *  - die when CDP dies (health probe), not when someone remembers.
 */
import { chmodSync, existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import {
    attemptStaleTakeover,
    buildPidRecord,
    clearPidFile,
    inspectPidFile,
    serializePidRecord,
} from "@genesiscz/utils/process/pidfile";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { CdpDeadlineError, Conn, localDebuggerUrl } from "./cdp.ts";
import type { CaptureChannel, RecordedEvent } from "./channels.ts";
import { ensureCaptureDir, metaPath, recorderPidPath } from "./paths.ts";
import { SegmentWriter } from "./segments.ts";

const { log } = logger.scoped("chrome-devtools:recorder");

/** Hard lifetime cap for recorders started with seconds=0 ("until CDP drops"). */
export const MAX_LIFETIME_SECONDS = 24 * 60 * 60;

export interface RecorderMeta {
    pid: number;
    port: number;
    channels: CaptureChannel[];
    scope: { match?: string; allTabs?: boolean };
    startedAt: number;
    argv: string[];
}

export function readRecorderMeta(port: number): RecorderMeta | null {
    const path = metaPath(port);
    if (!existsSync(path)) {
        return null;
    }

    try {
        const parsed = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as Partial<RecorderMeta>;

        // Shape-validate: a hand-edited or truncated meta.json must read as
        // absent, not crash doctor/status/follow downstream.
        if (typeof parsed?.pid !== "number" || typeof parsed.port !== "number" || !Array.isArray(parsed.channels)) {
            log.debug({ path }, "meta.json has no usable shape");

            return null;
        }

        return parsed as RecorderMeta;
    } catch (err) {
        log.debug({ err, path }, "meta.json unreadable");

        return null;
    }
}

export function isArmableUrl(url: string): boolean {
    const u = (url ?? "").trim().toLowerCase();
    if (!u) {
        return false;
    }

    if (
        u.startsWith("devtools:") ||
        u.startsWith("chrome:") ||
        u.startsWith("chrome-extension:") ||
        u.startsWith("brave:") ||
        u.startsWith("edge:") ||
        u.startsWith("about:srcdoc")
    ) {
        return false;
    }

    return u.startsWith("http:") || u.startsWith("https:") || u === "about:blank";
}

export function isArmableTarget(info: { type?: string; url?: string; openerId?: string }): boolean {
    const type = info.type ?? "";
    if (type !== "page" && type !== "iframe") {
        return false;
    }

    // A window.open() popup attaches with an empty URL before its first request; arm it then,
    // or that request (often the one a login flow is about) leaves the recording.
    if (type === "page" && !(info.url ?? "").trim() && info.openerId) {
        return true;
    }

    return isArmableUrl(info.url ?? "");
}

export function pickArmTargets<T extends { type?: string; url?: string }>(targets: T[]): T[] {
    return targets.filter((t) => isArmableTarget(t));
}

/** The chrome-har diet (see lib/har/build.ts) plus follow's nav/ws-lifecycle needs. */
const NET_METHODS = new Set([
    "Network.requestWillBeSent",
    "Network.requestServedFromCache",
    "Network.requestWillBeSentExtraInfo",
    "Network.responseReceivedExtraInfo",
    "Network.responseReceived",
    "Network.loadingFinished",
    "Network.loadingFailed",
    "Network.resourceChangedPriority",
    "Network.webSocketCreated",
    "Network.webSocketClosed",
    "Network.webSocketWillSendHandshakeRequest",
    "Network.webSocketHandshakeResponseReceived",
    "Page.frameStartedLoading",
    "Page.frameRequestedNavigation",
    "Page.navigatedWithinDocument",
    "Page.loadEventFired",
    "Page.domContentEventFired",
    "Page.frameAttached",
    "Page.frameNavigated",
]);

/** A release that does not answer in this time is dropped; the target is not ours to wait for. */
const RELEASE_TIMEOUT_MS = 5000;

const CONSOLE_METHODS = new Set(["Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Log.entryAdded"]);

const WS_FRAME_METHODS = new Set([
    "Network.webSocketFrameSent",
    "Network.webSocketFrameReceived",
    "Network.webSocketFrameError",
]);

export function isRecordedMethod(method: string, channels: ReadonlySet<CaptureChannel>): boolean {
    if (NET_METHODS.has(method)) {
        return true;
    }

    if (channels.has("console") && CONSOLE_METHODS.has(method)) {
        return true;
    }

    if (channels.has("ws") && WS_FRAME_METHODS.has(method)) {
        return true;
    }

    return false;
}

export interface DataAggregate {
    total: number;
    count: number;
    lastTimestamp: number;
}

/**
 * The dataReceived fast path. chrome-har needs dataLength totals for accurate
 * content sizes, but raw dataReceived packets are the CPU leak. So: never
 * JSON.parse them — regex the three fields out of the raw string, aggregate
 * in memory, and let the recorder emit ONE synthetic summary event when
 * loadingFinished arrives.
 */
export function extractDataReceived(
    raw: string
): { sessionId: string; requestId: string; dataLength: number; timestamp: number } | null {
    const requestId = raw.match(/"requestId":"([^"]+)"/)?.[1];
    const dataLength = raw.match(/"dataLength":(\d+)/)?.[1];
    if (!requestId || dataLength === undefined) {
        return null;
    }

    return {
        sessionId: raw.match(/"sessionId":"([^"]+)"/)?.[1] ?? "",
        requestId,
        dataLength: Number(dataLength),
        timestamp: Number(raw.match(/"timestamp":([\d.]+)/)?.[1] ?? 0),
    };
}

export interface PacketGate {
    dropRaw: (raw: string) => boolean;
    /** Drain the aggregate for one request (used at loadingFinished/Failed). */
    take: (sessionId: string | undefined, requestId: string) => DataAggregate | null;
}

export function makePacketGate(opts: { parseWsFrames: boolean }): PacketGate {
    const aggregates = new Map<string, DataAggregate>();

    return {
        dropRaw: (raw: string): boolean => {
            if (raw.includes('"method":"Network.dataReceived"')) {
                const data = extractDataReceived(raw);
                if (data) {
                    const key = `${data.sessionId} ${data.requestId}`;
                    const agg = aggregates.get(key);
                    if (agg) {
                        agg.total += data.dataLength;
                        agg.count += 1;
                        agg.lastTimestamp = data.timestamp;
                    } else {
                        aggregates.set(key, { total: data.dataLength, count: 1, lastTimestamp: data.timestamp });
                    }
                }

                return true;
            }

            if (!opts.parseWsFrames && raw.includes('"method":"Network.webSocketFrame')) {
                return true;
            }

            return false;
        },
        take: (sessionId, requestId) => {
            const key = `${sessionId ?? ""} ${requestId}`;
            const agg = aggregates.get(key);
            if (agg) {
                aggregates.delete(key);
                return agg;
            }

            return null;
        },
    };
}

export function nextHealthFails(prev: number, ok: boolean): number {
    return ok ? 0 : prev + 1;
}

export function healthIsDead(fails: number): boolean {
    return fails >= 3;
}

/**
 * Enable the recording domains on one tab session, in order. False means the session must be armed again on
 * its next target event: Network.enable failed, or a domain missed its deadline. A missed deadline means the
 * tab answers nothing (a frozen or discarded background tab), so the remaining domains are skipped: each would
 * wait out the same 30 s deadline and log the same warning (17 tabs gave 68 lines and 2 minutes each).
 */
/**
 * Arms a freshly attached session, then releases it. Browser-level auto-attach makes Chrome hold every
 * window.open() popup until the client sends Runtime.runIfWaitingForDebugger, even with
 * waitForDebuggerOnStart:false (Chromium target_handler.cc, ShouldThrottlePopups). A held popup pauses its
 * whole renderer, and its opener shows "Debugger paused in another tab" until the popup is released.
 * `arm` sends its first enable synchronously, so that enable reaches the target before the release and the
 * popup's first request is still recorded. The release never waits for the enables to answer, and it goes
 * to every session, armable or not: a held popup reports an empty URL, which is not armable.
 */
export function armThenRelease({
    arm,
    send,
    sessionId,
}: {
    arm: () => Promise<void>;
    send: (method: string) => Promise<unknown>;
    sessionId: string;
}): void {
    void arm();
    if (!sessionId) {
        return;
    }

    void send("Runtime.runIfWaitingForDebugger").catch((err: unknown) => {
        log.debug({ err, sessionId }, "runIfWaitingForDebugger failed");
    });
}

export async function enableRecordingDomains({
    send,
    domains,
    url,
}: {
    send: (method: string) => Promise<unknown>;
    domains: string[];
    url: string;
}): Promise<boolean> {
    let armed = true;

    for (const [index, method] of domains.entries()) {
        try {
            await send(method);
        } catch (err) {
            if (err instanceof CdpDeadlineError) {
                log.warn({ err, method, url, skipped: domains.slice(index + 1) }, "domain enable failed");
                return false;
            }

            log.warn({ err, method, url }, "domain enable failed");

            if (method === "Network.enable") {
                armed = false;
            }
        }
    }

    return armed;
}

export async function probeCdp(
    port: number,
    get: (url: string, init?: RequestInit) => Promise<Response> = fetch
): Promise<boolean> {
    try {
        const r = await get(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });

        return r.ok;
    } catch {
        return false;
    }
}

export function recordScopeError(opts: { match?: string; allTabs?: boolean }): string | null {
    if (opts.allTabs) {
        return null;
    }

    if (opts.match?.trim()) {
        return null;
    }

    return [
        "record needs a scope. Pick one:",
        "  --match <url-substr>   record only tabs whose URL contains this (cheapest)",
        "  --all-tabs             record every http(s) tab",
    ].join("\n");
}

export function resolveRecordSeconds(raw?: string | number): number {
    if (raw === undefined || raw === "") {
        return 600;
    }

    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n) || n < 0) {
        return 600;
    }

    return n;
}

export function waitUntilRecorderDone(opts: {
    closed: Promise<void>;
    seconds: number;
    signal?: AbortSignal;
}): Promise<"close" | "timeout" | "signal"> {
    return new Promise((resolve) => {
        let done = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (reason: "close" | "timeout" | "signal") => {
            if (done) {
                return;
            }

            done = true;
            if (timer) {
                clearTimeout(timer);
            }

            resolve(reason);
        };

        void opts.closed.then(() => finish("close"));
        const effectiveSeconds = opts.seconds > 0 ? opts.seconds : MAX_LIFETIME_SECONDS;
        timer = setTimeout(() => finish("timeout"), effectiveSeconds * 1000);

        if (opts.signal) {
            if (opts.signal.aborted) {
                finish("signal");
            } else {
                opts.signal.addEventListener("abort", () => finish("signal"), { once: true });
            }
        }
    });
}

function errCode(err: unknown): string | undefined {
    return (err as NodeJS.ErrnoException).code;
}

/**
 * Remove `recorder.pid.stale-*` temp files whose creating process is dead —
 * residue of a takeover that crashed between rename and cleanup. The creator's
 * pid is embedded in the name; a live creator is mid-takeover and left alone.
 */
export function sweepDeadTakeoverTemps(pidPath: string): void {
    const dir = dirname(pidPath);
    const prefix = `${basename(pidPath)}.stale-`;

    let names: string[];
    try {
        names = readdirSync(dir);
    } catch (err) {
        log.debug({ err, dir }, "takeover temp sweep skipped (dir unreadable)");

        return;
    }

    for (const name of names) {
        if (!name.startsWith(prefix)) {
            continue;
        }

        const creator = Number(name.slice(prefix.length).split("-")[0]);
        if (!Number.isInteger(creator) || creator <= 0) {
            continue;
        }

        // EPERM means alive but not ours, so the creator is still mid-takeover.
        // The pid comes from a filename, so it may be non-finite or non-positive.
        const alive = isProcessAlive(creator);

        if (alive) {
            continue;
        }

        try {
            unlinkSync(join(dir, name));
            log.debug({ name, creator }, "swept dead takeover temp");
        } catch (err) {
            log.debug({ err, name }, "takeover temp sweep unlink failed");
        }
    }
}

/**
 * Claim the recorder pidfile atomically via the shared pidfile protocol
 * (async `wx` create + rename-verify stale takeover — see
 * `attemptStaleTakeover` in src/utils/process/pidfile.ts). A live OR
 * unverified foreign owner fails fast: `unverified` means the pid is ALIVE
 * but the OS would not name it (the normal Windows answer), and stealing an
 * alive recorder's claim is exactly the double-parser failure this exists to
 * prevent. Only EEXIST enters the recovery path — permission/disk faults
 * surface as themselves. Exported for the concurrency test.
 */
export async function claimRecorderPidfile(pidPath: string, port: number): Promise<void> {
    sweepDeadTakeoverTemps(pidPath);

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await writeFile(pidPath, serializePidRecord(buildPidRecord()), { flag: "wx" });

            return;
        } catch (err) {
            if (errCode(err) !== "EEXIST") {
                throw err;
            }
        }

        const state = inspectPidFile(pidPath);
        if ((state.status === "live" || state.status === "unverified") && state.pid !== process.pid) {
            throw new Error(`recorder already up on ${port} (pid ${state.pid}). Stop it: record --port ${port} --stop`);
        }

        let staleContent: string | null = null;
        try {
            staleContent = readFileSync(pidPath, "utf8");
        } catch (err) {
            log.debug({ err, pidPath }, "stale pidfile vanished; retrying fresh create");
            continue;
        }

        if (await attemptStaleTakeover(pidPath, staleContent)) {
            return;
        }

        log.debug({ attempt, port }, "lost pidfile takeover round; re-checking");
    }

    throw new Error(`lost the recorder claim race on ${port}; another instance is recording`);
}

export async function connectBrowser(
    port: number,
    opts?: {
        dropRaw?: (raw: string) => boolean;
        signal?: AbortSignal;
        fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
    }
): Promise<Conn> {
    const signal = opts?.signal ?? AbortSignal.timeout(10_000);
    const v = (await (await (opts?.fetcher ?? fetch)(`http://127.0.0.1:${port}/json/version`, { signal })).json()) as {
        webSocketDebuggerUrl: string;
    };

    const conn = new Conn(localDebuggerUrl(v, port), { ...opts, signal });
    try {
        await conn.send("Browser.getVersion", {}, undefined, { signal });
        return conn;
    } catch (err) {
        conn.close();
        throw err;
    }
}

export interface RunRecorderOpts {
    port: number;
    match?: string;
    allTabs?: boolean;
    seconds?: number;
    channels: CaptureChannel[];
}

type RecorderTargetInfo = { url?: string; type?: string; targetId?: string; openerId?: string; sessionId?: string };

function parseRecorderTargetInfo(value: unknown): RecorderTargetInfo {
    const info: RecorderTargetInfo = {};
    if (!value || typeof value !== "object") {
        return info;
    }

    for (const [key, field] of Object.entries(value)) {
        if (
            typeof field === "string" &&
            (key === "url" || key === "type" || key === "targetId" || key === "openerId" || key === "sessionId")
        ) {
            info[key] = field;
        }
    }

    return info;
}

/** Tracks attached sessions separately from armed targets so a later URL change can arm a scoped tab. */
export function createRecorderTargetController(opts: {
    conn: Pick<Conn, "send">;
    channels: ReadonlySet<CaptureChannel>;
    match?: string;
}) {
    const enabled = new Set<string>();
    const attachedTargets = new Map<string, string>();
    const sessions = new Map<string, string>();
    const scopedTargets = new Set<string>();
    const pendingPopups = new Set<string>();
    const firstRequests = new Map<string, string>();

    const enable = async (sessionId: string, info: RecorderTargetInfo) => {
        const { url = "", type, targetId, openerId } = info;
        if (targetId && sessionId && !sessions.has(targetId)) {
            sessions.set(targetId, sessionId);
        }

        const armable = isArmableTarget({ type: type ?? "page", url, openerId });
        const openerScoped = Boolean(opts.match && type === "page" && !url && openerId && scopedTargets.has(openerId));
        const inScope = !opts.match || url.includes(opts.match) || openerScoped;
        if (targetId && url && (!armable || !inScope)) {
            scopedTargets.delete(targetId);
        }

        if (!sessionId || !armable || !inScope) {
            return;
        }

        if (targetId) {
            scopedTargets.add(targetId);
            const owner = attachedTargets.get(targetId);
            if (owner && owner !== sessionId) {
                return;
            }

            attachedTargets.set(targetId, sessionId);
        }

        if (enabled.has(sessionId)) {
            return;
        }

        enabled.add(sessionId);
        if (openerScoped) {
            pendingPopups.add(sessionId);
        }

        const domains = ["Network.enable", "Page.enable"];
        if (opts.channels.has("console")) {
            domains.push("Runtime.enable", "Log.enable");
        }

        const armed = await enableRecordingDomains({
            send: (method) => opts.conn.send(method, {}, sessionId),
            domains,
            url,
        });
        if (!armed) {
            enabled.delete(sessionId);
            pendingPopups.delete(sessionId);
            firstRequests.delete(sessionId);
        }
    };

    const onTargetEvent = (method: string, params: Record<string, unknown>, sessionId?: string): boolean => {
        if (method === "Target.attachedToTarget") {
            const info = parseRecorderTargetInfo(params.targetInfo);
            const sid = String(params.sessionId ?? sessionId ?? "");
            if (info.targetId && sid && !sessions.has(info.targetId)) {
                sessions.set(info.targetId, sid);
            }

            armThenRelease({
                arm: () => enable(sid, info),
                send: (release) => opts.conn.send(release, {}, sid, { timeoutMs: RELEASE_TIMEOUT_MS }),
                sessionId: sid,
            });
            return true;
        }

        if (method === "Target.targetInfoChanged") {
            const info = parseRecorderTargetInfo(params.targetInfo ?? params);
            const sid = String(sessionId ?? info.sessionId ?? (info.targetId ? sessions.get(info.targetId) : "") ?? "");
            if (sid) {
                void enable(sid, info);
            }

            return true;
        }

        if (method === "Target.detachedFromTarget") {
            const sid = String(params.sessionId ?? sessionId ?? "");
            enabled.delete(sid);
            pendingPopups.delete(sid);
            firstRequests.delete(sid);
            for (const [targetId, owner] of sessions) {
                if (owner === sid) {
                    sessions.delete(targetId);
                }
            }

            for (const [targetId, owner] of attachedTargets) {
                if (owner === sid) {
                    attachedTargets.delete(targetId);
                    scopedTargets.delete(targetId);
                }
            }

            return true;
        }

        return false;
    };

    const shouldRecord = ({
        method,
        params,
        sessionId,
        url,
    }: {
        method: string;
        params: Record<string, unknown>;
        sessionId: string | undefined;
        url: string;
    }): boolean => {
        const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
        if (sessionId && requestId && method === "Network.requestWillBeSent" && pendingPopups.delete(sessionId)) {
            firstRequests.set(sessionId, requestId);
        }

        const firstRequest = !!sessionId && !!requestId && firstRequests.get(sessionId) === requestId;
        if (firstRequest && sessionId && (method === "Network.loadingFinished" || method === "Network.loadingFailed")) {
            firstRequests.delete(sessionId);
        }

        return firstRequest || !opts.match || !url || url.includes(opts.match);
    };

    return { enable, attachedTargets, onTargetEvent, shouldRecord };
}

export async function runRecorder(opts: RunRecorderOpts): Promise<void> {
    const scopeErr = recordScopeError({ match: opts.match, allTabs: opts.allTabs });
    if (scopeErr) {
        throw new Error(scopeErr);
    }

    const seconds = resolveRecordSeconds(opts.seconds);
    const channels = new Set<CaptureChannel>(["net", ...opts.channels]);
    const dir = ensureCaptureDir(opts.port);
    const pidPath = recorderPidPath(opts.port);

    const state = inspectPidFile(pidPath);
    if (state.status === "live" && state.pid !== process.pid) {
        throw new Error(
            `recorder already up on ${opts.port} (pid ${state.pid}). Stop it: record --port ${opts.port} --stop`
        );
    }

    // Claim BEFORE the connect — the incident's load-bearing rule. Two
    // concurrent `record` calls racing through inspect+connect would otherwise
    // both attach browser-wide (double parsers, doubled events). The claim is
    // an async atomic `wx` create with a rename-verify takeover for stale
    // records — see claimRecorderPidfile above for why sync fs cannot do this.
    const gate = makePacketGate({ parseWsFrames: channels.has("ws") });
    await claimRecorderPidfile(pidPath, opts.port);

    let conn: Conn;
    try {
        conn = await connectBrowser(opts.port, { dropRaw: gate.dropRaw });
    } catch (err) {
        clearPidFile(pidPath);
        throw new Error(
            `no CDP endpoint on ${opts.port} (${err instanceof Error ? err.message : String(err)}). See live ports: attach`
        );
    }

    const meta: RecorderMeta = {
        pid: process.pid,
        port: opts.port,
        channels: [...channels],
        scope: { match: opts.match, allTabs: opts.allTabs },
        startedAt: Date.now(),
        argv: process.argv.slice(2),
    };
    try {
        await Bun.write(metaPath(opts.port), `${SafeJSON.stringify(meta, { strict: true }, 2)}\n`);
        // Meta records the scope/argv of a capture that holds credentials — owner-only.
        chmodSync(metaPath(opts.port), 0o600);
    } catch (err) {
        clearPidFile(pidPath);
        throw err;
    }

    const writer = new SegmentWriter(dir);

    const bodyUrls = new Map<string, string>();
    const match = opts.allTabs ? undefined : opts.match;
    const ac = new AbortController();
    const onStop = () => ac.abort();
    process.once("SIGTERM", onStop);
    process.once("SIGINT", onStop);
    let healthFails = 0;
    const healthTimer = setInterval(() => {
        void probeCdp(opts.port).then((ok) => {
            healthFails = nextHealthFails(healthFails, ok);
            if (healthIsDead(healthFails)) {
                ac.abort();
            }
        });
    }, 2000);

    // ONE teardown order, shared by the setup-failure catch and the normal
    // finally — two copies would diverge the day a new resource is added.
    const teardown = () => {
        clearInterval(healthTimer);
        process.off("SIGTERM", onStop);
        process.off("SIGINT", onStop);
        conn.close();
        writer.close();
        clearPidFile(recorderPidPath(opts.port));
    };

    const record = (event: RecordedEvent) => {
        writer.write(event);
    };

    const { enable, attachedTargets, onTargetEvent, shouldRecord } = createRecorderTargetController({
        conn,
        channels,
        match,
    });

    // Register listeners BEFORE setAutoAttach, or we miss Target.attachedToTarget for existing tabs.
    conn.on((method, params, sessionId) => {
        if (onTargetEvent(method, params, sessionId)) {
            return;
        }

        if (!isRecordedMethod(method, channels)) {
            return;
        }

        const url = String(
            (params.request as { url?: string } | undefined)?.url ??
                (params.response as { url?: string } | undefined)?.url ??
                (params.redirectResponse as { url?: string } | undefined)?.url ??
                ""
        );

        if (!shouldRecord({ method, params, sessionId, url })) {
            return;
        }

        // Synthesize the aggregated dataReceived summary right before the finish
        // event, so the HAR builder sees sizes without the packet flood.
        if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
            const agg = gate.take(sessionId, String(params.requestId ?? ""));
            if (agg && method === "Network.loadingFinished") {
                record({
                    method: "Network.dataReceived",
                    params: {
                        requestId: params.requestId,
                        timestamp: agg.lastTimestamp,
                        dataLength: agg.total,
                        encodedDataLength: 0,
                    },
                    sessionId,
                    t: Date.now(),
                });
            }
        }

        record({ method, params, sessionId, t: Date.now() });

        if (channels.has("body") && method === "Network.responseReceived" && url) {
            bodyUrls.set(`${sessionId ?? ""} ${params.requestId}`, url);
        }

        if (channels.has("body") && method === "Network.loadingFinished" && sessionId) {
            const key = `${sessionId} ${params.requestId}`;
            const bodyUrl = bodyUrls.get(key);
            if (bodyUrl) {
                bodyUrls.delete(key);
                void conn
                    .send("Network.getResponseBody", { requestId: params.requestId }, sessionId)
                    .then((r) => {
                        const body = (r as { body?: string }).body ?? "";
                        record({
                            method: "Genesis.responseBody",
                            params: { url: bodyUrl, requestId: params.requestId, body: String(body).slice(0, 2048) },
                            sessionId,
                            t: Date.now(),
                        });
                    })
                    .catch((err: unknown) => {
                        log.debug({ err, url: bodyUrl }, "body fetch failed");
                    });
            }
        }

        if (channels.has("storage") && method === "Page.frameNavigated" && sessionId) {
            const frame = params.frame as { parentId?: string; url?: string } | undefined;
            if (frame && !frame.parentId) {
                void conn
                    .send(
                        "Runtime.evaluate",
                        {
                            expression:
                                "JSON.stringify({ls: Object.keys(localStorage).length, ss: Object.keys(sessionStorage).length, lsKeys: Object.keys(localStorage).slice(0,8)})",
                            returnByValue: true,
                        },
                        sessionId
                    )
                    .then((r) => {
                        const value = (r as { result?: { value?: string } }).result?.value;
                        if (!value) {
                            return;
                        }

                        const snap = SafeJSON.parse(value, { strict: true }) as Record<string, unknown>;
                        record({
                            method: "Genesis.storageSnapshot",
                            params: { url: frame.url, ...snap },
                            sessionId,
                            t: Date.now(),
                        });
                    })
                    .catch((err: unknown) => {
                        log.debug({ err }, "storage snapshot failed");
                    });
            }
        }
    });

    // A throw in the setup sends must not strand the pidfile claim: tear down
    // and clear before propagating (the normal-path finally sits further down).
    try {
        await conn.send("Target.setDiscoverTargets", { discover: true });
        await conn.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
        const existing = (await conn.send("Target.getTargets").catch(() => ({ targetInfos: [] }))) as {
            targetInfos?: { targetId: string; type?: string; url?: string }[];
        };

        for (const t of pickArmTargets(existing.targetInfos ?? [])) {
            if (match && !(t.url ?? "").includes(match)) {
                continue;
            }

            // Auto-attach already delivered a session for most existing targets;
            // the sweep only covers stragglers, never a second session.
            if (attachedTargets.has(t.targetId)) {
                continue;
            }

            try {
                const attached = (await conn.send("Target.attachToTarget", {
                    targetId: t.targetId,
                    flatten: true,
                })) as {
                    sessionId?: string;
                };
                const sid = attached.sessionId;
                if (sid) {
                    armThenRelease({
                        arm: () => enable(sid, t),
                        send: (release) => conn.send(release, {}, sid, { timeoutMs: RELEASE_TIMEOUT_MS }),
                        sessionId: sid,
                    });
                }
            } catch (err) {
                log.warn({ err, url: t.url }, "attachToTarget failed");
            }
        }
    } catch (err) {
        teardown();
        throw err;
    }

    const ttl = seconds > 0 ? `ttl ${seconds}s` : `until CDP drops (max ${MAX_LIFETIME_SECONDS / 3600}h)`;
    const scope = match ? `match ${match}` : "all http(s) tabs";
    log.out.info(
        `recording port ${opts.port} pid ${process.pid} -> ${dir} (${scope}, channels ${[...channels].join(",")}, ${ttl})`
    );
    log.out.info(`stop: record --port ${opts.port} --stop   (or kill ${process.pid})`);

    try {
        const reason = await waitUntilRecorderDone({ closed: conn.closed, seconds, signal: ac.signal });
        record({ method: "Genesis.marker", params: { kind: "recorderExit", detail: reason }, t: Date.now() });
        log.out.info(`recorder exiting (${reason})`);
    } finally {
        teardown();
    }
}
