/**
 * Readiness probes — wait until the spawned child is ready to serve.
 *
 * Three probe kinds match the `ReadinessProbe` union in `types.ts`:
 *  - **http** — fetch(`http://localhost:<port><path>`) until a serving response
 *    (2xx–4xx; 502/503/504 gateway statuses keep polling — front-proxy can bind
 *    before Vite/ttyd upstream is up).
 *  - **log** — tail the bg log until the regex matches.
 *  - **port** — wait for the TCP port to bind (simplest, used as fallback).
 *
 * Each takes a deadline; on timeout the function returns `{ ready: false }`
 * and the caller decides whether to detach the child anyway (dev-dashboard
 * does this on `restart` after 30s — see plan §Decisions).
 *
 * An optional `signal` ends the wait early. The launcher aborts it when the
 * child exits, so a crashed server is reported at once, not after the deadline.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { logger } from "@genesiscz/utils/logger";
import { isPortInUse } from "@genesiscz/utils/network";
import { stripAnsi } from "@genesiscz/utils/string";
import type { ReadinessProbe } from "./types";

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

/** Gateway statuses: TCP listener is up but upstream is not serving yet. */
const GATEWAY_UNAVAILABLE = new Set([502, 503, 504]);

export function isHttpServingStatus(status: number): boolean {
    return status > 0 && !GATEWAY_UNAVAILABLE.has(status);
}

export interface ReadinessResult {
    ready: boolean;
    /** What we observed last (helpful when ready:false). */
    detail?: string;
}

export async function waitForReady(
    probe: ReadinessProbe | undefined,
    args: { port: number; logFile: string; signal?: AbortSignal }
): Promise<ReadinessResult> {
    if (!probe) {
        // Default = wait for the TCP port to bind.
        return waitForPort({ kind: "port" }, args.port, args.signal);
    }

    switch (probe.kind) {
        case "http":
            return waitForHttp(probe, args.port, args.signal);
        case "log":
            return waitForLog(probe, args.logFile, args.signal);
        case "port":
            return waitForPort(probe, args.port, args.signal);
    }
}

function abortedResult(signal: AbortSignal): ReadinessResult {
    const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason);
    return { ready: false, detail: reason };
}

async function waitForPort(
    probe: { kind: "port"; timeoutMs?: number },
    port: number,
    signal?: AbortSignal
): Promise<ReadinessResult> {
    const deadline = Date.now() + (probe.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    while (Date.now() < deadline) {
        if (signal?.aborted) {
            return abortedResult(signal);
        }

        if (await isPortInUse(port)) {
            return { ready: true };
        }
        await Bun.sleep(POLL_INTERVAL_MS);
    }
    return { ready: false, detail: `port ${port} still free after ${probe.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` };
}

async function waitForHttp(
    probe: { kind: "http"; path?: string; timeoutMs?: number },
    port: number,
    signal?: AbortSignal
): Promise<ReadinessResult> {
    const url = `http://localhost:${port}${probe.path ?? "/"}`;
    return waitForUrlReady(url, probe.timeoutMs ?? DEFAULT_TIMEOUT_MS, { signal });
}

export async function waitForUrlReady(
    url: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    options: { signal?: AbortSignal } = {}
): Promise<ReadinessResult> {
    const { signal } = options;
    const deadline = Date.now() + timeoutMs;
    let lastStatus: number | undefined;
    let lastError: unknown;

    while (Date.now() < deadline) {
        if (signal?.aborted) {
            return abortedResult(signal);
        }

        try {
            const attemptTimeout = AbortSignal.timeout(2_000);
            const res = await fetch(url, {
                redirect: "manual",
                signal: signal ? AbortSignal.any([attemptTimeout, signal]) : attemptTimeout,
            });
            lastStatus = res.status;

            // 4xx still means the app is serving; 502/503/504 means proxy-without-upstream.
            if (isHttpServingStatus(res.status)) {
                return { ready: true, detail: `http ${res.status}` };
            }
        } catch (err) {
            lastError = err;
            logger.debug({ err, url }, "http readiness probe failed");
        }
        await Bun.sleep(POLL_INTERVAL_MS);
    }

    const statusSuffix = lastStatus !== undefined ? ` (last status ${lastStatus})` : "";
    const errorSuffix =
        lastError !== undefined
            ? ` (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})`
            : "";
    return { ready: false, detail: `${url} did not respond in ${timeoutMs}ms${statusSuffix}${errorSuffix}` };
}

async function waitForLog(
    probe: { kind: "log"; regex: RegExp; timeoutMs?: number },
    logFile: string,
    signal?: AbortSignal
): Promise<ReadinessResult> {
    const deadline = Date.now() + (probe.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let pos = 0;
    let acc = "";

    while (Date.now() < deadline) {
        if (signal?.aborted) {
            return abortedResult(signal);
        }

        if (existsSync(logFile)) {
            const size = statSync(logFile).size;
            if (size > pos) {
                const fd = openSync(logFile, "r");
                try {
                    const buf = Buffer.alloc(size - pos);
                    const read = readSync(fd, buf, 0, buf.length, pos);
                    pos += read;
                    acc += stripAnsi(buf.subarray(0, read).toString());
                    if (acc.length > 8_000) {
                        acc = acc.slice(-4_000);
                    }
                    probe.regex.lastIndex = 0;
                    if (probe.regex.test(acc)) {
                        return { ready: true, detail: `log matched ${probe.regex}` };
                    }
                } finally {
                    closeSync(fd);
                }
            }
        }
        await Bun.sleep(POLL_INTERVAL_MS);
    }

    return { ready: false, detail: `log marker ${probe.regex} not seen in ${probe.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` };
}
