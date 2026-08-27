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
import { Conn } from "./cdp.ts";
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

export function isArmableTarget(info: { type?: string; url?: string }): boolean {
    const type = info.type ?? "";
    if (type !== "page" && type !== "iframe") {
        return false;
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

        // isProcessAlive owns this exact ESRCH-vs-EPERM distinction (EPERM means
        // alive but not ours, so the creator is still mid-takeover). Hand-rolling
        // the probe here is what the pid-safety guard rejects, and the shared
        // helper also guards a non-finite or non-positive pid, which a filename
        // can absolutely produce.
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

export async function connectBrowser(port: number, opts?: { dropRaw?: (raw: string) => boolean }): Promise<Conn> {
    const v = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
        webSocketDebuggerUrl: string;
    };

    const conn = new Conn(v.webSocketDebuggerUrl, opts);
    // Prove the websocket actually OPENED before returning: without this, a
    // ws failure surfaces at the first later send(), outside the caller's
    // pidfile-clearing catch, and leaves a stale claim behind.
    await conn.send("Browser.getVersion");

    return conn;
}

export interface RunRecorderOpts {
    port: number;
    match?: string;
    allTabs?: boolean;
    seconds?: number;
    channels: CaptureChannel[];
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

    const enabled = new Set<string>();
    // One recording session per TARGET. Chrome (151+) auto-attaches existing
    // targets on setAutoAttach AND answers the explicit attachToTarget sweep,
    // which yields two sessions per tab and every event twice — verified live
    // (doubled follow lines, doubled HAR entries) before this guard existed.
    const attachedTargets = new Map<string, string>();
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

    const enable = async (sessionId: string, url: string, type?: string, targetId?: string) => {
        if (!isArmableTarget({ type: type ?? "page", url })) {
            return;
        }

        if (match && !url.includes(match)) {
            return;
        }

        if (enabled.has(sessionId)) {
            return;
        }

        if (targetId) {
            const owner = attachedTargets.get(targetId);
            if (owner && owner !== sessionId) {
                return;
            }

            attachedTargets.set(targetId, sessionId);
        }

        enabled.add(sessionId);
        const domains = ["Network.enable", "Page.enable"];
        if (channels.has("console")) {
            domains.push("Runtime.enable", "Log.enable");
        }

        for (const method of domains) {
            await conn.send(method, {}, sessionId).catch((err: unknown) => {
                log.warn({ err, method, url }, "domain enable failed");
                if (method === "Network.enable") {
                    enabled.delete(sessionId);
                }
            });
        }
    };

    // Register listeners BEFORE setAutoAttach, or we miss Target.attachedToTarget for existing tabs.
    conn.on((method, params, sessionId) => {
        if (method === "Target.attachedToTarget") {
            const info = (params.targetInfo ?? {}) as { type?: string; url?: string; targetId?: string };
            const sid = String(params.sessionId ?? sessionId ?? "");
            void enable(sid, info.url ?? "", info.type, info.targetId);

            return;
        }

        if (method === "Target.targetInfoChanged") {
            const info = (params.targetInfo ?? params) as {
                type?: string;
                url?: string;
                sessionId?: string;
                targetId?: string;
            };
            const sid = String(sessionId ?? info.sessionId ?? "");
            if (sid) {
                void enable(sid, info.url ?? "", info.type, info.targetId);
            }

            return;
        }

        if (method === "Target.detachedFromTarget") {
            const sid = String(params.sessionId ?? sessionId ?? "");
            enabled.delete(sid);
            for (const [targetId, owner] of attachedTargets) {
                if (owner === sid) {
                    attachedTargets.delete(targetId);
                }
            }

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

        if (match && url && !url.includes(match)) {
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
                if (attached.sessionId) {
                    await enable(attached.sessionId, t.url ?? "", t.type, t.targetId);
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
