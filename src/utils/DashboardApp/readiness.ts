/**
 * Readiness probes — wait until the spawned child is ready to serve.
 *
 * Three probe kinds match the `ReadinessProbe` union in `types.ts`:
 *  - **http** — fetch(`http://localhost:<port><path>`) until a serving response
 *    (2xx–4xx; 502/503/504 gateway statuses keep polling — front-proxy can bind
 *    before Vite/ttyd upstream is up). Any other 5xx is a server that answers but
 *    fails: it is polled for `BROKEN_GRACE_MS` more, then reported `broken`.
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
import { logger, out } from "@genesiscz/utils/logger";
import { isPortInUse } from "@genesiscz/utils/network";
import { stripAnsi } from "@genesiscz/utils/string";
import type { DashboardAppConfig, ReadinessProbe } from "./types";

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

/** Gateway statuses: TCP listener is up but upstream is not serving yet. */
const GATEWAY_UNAVAILABLE = new Set([502, 503, 504]);
/**
 * How long a server that answers 500 keeps being polled before it counts as broken. A Vite dashboard can fail its very
 * first request while it optimizes dependencies; a module that throws at load time fails every request after that.
 */
const BROKEN_GRACE_MS = 5_000;

export function isHttpServingStatus(status: number): boolean {
    return status > 0 && !GATEWAY_UNAVAILABLE.has(status);
}

/** A 5xx that is not a gateway status: the app itself answered with an error. */
export function isHttpBrokenStatus(status: number): boolean {
    return status >= 500 && !GATEWAY_UNAVAILABLE.has(status);
}

export interface ReadinessResult {
    ready: boolean;
    /** What we observed last (helpful when ready:false). */
    detail?: string;
    /**
     * The server answers, but with an error (`tools clarity ui` answered 500 on every page while its launch printed
     * "ready", 2026-10-22). `ready` stays true, so callers that only need a listener keep working; a launch reports it.
     */
    broken?: { url: string; status: number; body: string };
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
    options: { signal?: AbortSignal; brokenGraceMs?: number } = {}
): Promise<ReadinessResult> {
    const { signal, brokenGraceMs = BROKEN_GRACE_MS } = options;
    const deadline = Date.now() + timeoutMs;
    let lastStatus: number | undefined;
    let lastError: unknown;
    let broken: { since: number; status: number; body: string } | undefined;

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

            if (isHttpBrokenStatus(res.status)) {
                const body = (await res.text()).replace(/\s+/g, " ").trim().slice(0, 300);
                broken = { since: broken?.since ?? Date.now(), status: res.status, body };

                if (Date.now() - broken.since >= brokenGraceMs) {
                    return brokenResult(url, broken);
                }
            } else if (isHttpServingStatus(res.status)) {
                // 4xx still means the app is serving; 502/503/504 means proxy-without-upstream.
                return { ready: true, detail: `http ${res.status}` };
            } else {
                // A gateway status: nothing behind the proxy answers now, so an earlier 500 no longer means serving.
                broken = undefined;
            }
        } catch (err) {
            // The server stopped answering: an earlier 500 must not be reported as a listener at the deadline.
            broken = undefined;
            lastError = err;
            logger.debug({ err, url }, "http readiness probe failed");
        }
        await Bun.sleep(POLL_INTERVAL_MS);
    }

    if (broken) {
        return brokenResult(url, broken);
    }

    const statusSuffix = lastStatus !== undefined ? ` (last status ${lastStatus})` : "";
    const errorSuffix =
        lastError !== undefined
            ? ` (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})`
            : "";
    return { ready: false, detail: `${url} did not respond in ${timeoutMs}ms${statusSuffix}${errorSuffix}` };
}

function brokenResult(url: string, broken: { status: number; body: string }): ReadinessResult {
    logger.warn({ url, status: broken.status, body: broken.body }, "dashboard answers with a server error");
    return {
        ready: true,
        detail: `http ${broken.status}`,
        broken: { url, status: broken.status, body: broken.body },
    };
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

/** An error's first line: `TypeError: …`, `Error: …`, `Error [ERR_X]: …`. */
const ERROR_HEADER = /^\s*(?:[A-Z]\w*)?Error(?:\s*\[[A-Z_]+\])?:\s/;
/** Any line that names an error, for a log whose errors have no header line. */
const ERROR_LINE = /\b(?:[A-Z]\w*Error|ERR_[A-Z_]+)\b/;
const STACK_LINE = /^\s*at\s/;
const ERROR_CODE_LINE = /^\s*code:\s/;

/**
 * The last error in a dashboard's log and the top of its stack (at most `maxLines`), ANSI stripped: what a broken
 * page's server printed. Bun prints the header, then properties (`code: "ERR_…"`), a blank line and the stack; the
 * code line is kept, the other properties are not. Reads only the last 64 KB; an absent or unreadable log gives none.
 */
export function serverErrorExcerpt(logFile: string, maxLines = 8): string[] {
    if (!existsSync(logFile)) {
        return [];
    }

    let text: string;
    let fd: number | undefined;
    try {
        fd = openSync(logFile, "r");
        const size = statSync(logFile).size;
        const length = Math.min(size, 64 * 1024);
        const buf = Buffer.alloc(length);
        const read = readSync(fd, buf, 0, length, size - length);
        text = stripAnsi(buf.subarray(0, read).toString());
    } catch (err) {
        logger.debug({ err, logFile }, "dashboard log unreadable for the error excerpt");
        return [];
    } finally {
        if (fd !== undefined) {
            closeSync(fd);
        }
    }

    const lines = text.split("\n");
    // A loop, not findLastIndex: the dashboards' tsconfigs predate ES2023.
    const lastMatch = (pattern: RegExp): number => {
        for (let index = lines.length - 1; index >= 0; index--) {
            if (pattern.test(lines[index]) && !STACK_LINE.test(lines[index])) {
                return index;
            }
        }

        return -1;
    };
    const header = lastMatch(ERROR_HEADER);
    const start = header >= 0 ? header : lastMatch(ERROR_LINE);

    if (start < 0) {
        return [];
    }

    const excerpt = [lines[start].trim()];
    let inStack = false;
    for (const line of lines.slice(start + 1)) {
        if (excerpt.length >= maxLines) {
            break;
        }

        if (STACK_LINE.test(line)) {
            inStack = true;
            excerpt.push(line.trim());
        } else if (inStack && line.trim()) {
            break;
        } else if (!inStack && ERROR_CODE_LINE.test(line)) {
            excerpt.push(line.trim());
        }
    }

    return excerpt;
}

/**
 * A dashboard that started but answers its pages with a server error: the error, the server's own message from its
 * log, and exit code 1, so the run is a failure (the CLI failure log records it with this text). The server keeps
 * running: a dev server reloads the fixed module.
 */
export function reportBrokenDashboard(
    config: Pick<DashboardAppConfig, "key" | "name">,
    broken: NonNullable<ReadinessResult["broken"]>,
    logFile: string,
    pid?: number
): void {
    const cause = serverErrorExcerpt(logFile);
    out.error(
        [
            `${config.name ?? config.key} started${pid ? ` (pid ${pid})` : ""}, but ${broken.url} answers ${broken.status}: ${broken.body || "(empty body)"}`,
            ...(cause.length > 0 ? ["  Server error:", ...cause.map((line) => `    ${line}`)] : []),
            `  Log: ${logFile}`,
        ].join("\n")
    );
    process.exitCode = 1;
}
