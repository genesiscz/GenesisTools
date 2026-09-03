import { logger } from "@genesiscz/utils/logger";
import type { CheckResult, Watcher } from "../types";

export function describeFetchError(error: unknown, timeoutMs: number): string {
    if (error instanceof Error) {
        if (error.name === "TimeoutError" || error.name === "AbortError") {
            return `timed out after ${Math.round(timeoutMs / 1000)} s`;
        }

        const cause = "cause" in error && error.cause instanceof Error ? `: ${error.cause.message}` : "";

        return `${error.message}${cause}`;
    }

    return String(error);
}

export interface TimedFetch {
    response: Response;
    latencyMs: number;
}

export async function timedFetch(url: string, init: RequestInit, timeoutMs: number): Promise<TimedFetch> {
    const started = performance.now();
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });

    return { response, latencyMs: Math.round(performance.now() - started) };
}

export async function checkWebsite(watcher: Pick<Watcher, "target" | "config" | "timeoutMs">): Promise<CheckResult> {
    const method = watcher.config.method ?? "GET";
    const headers: Record<string, string> = {
        "User-Agent": "genesis-tools-monitor/1.0",
        ...watcher.config.headers,
    };
    let fetched: TimedFetch;

    try {
        fetched = await timedFetch(watcher.target, { method, headers }, watcher.timeoutMs);
    } catch (error) {
        const detail = describeFetchError(error, watcher.timeoutMs);
        logger.debug({ error, target: watcher.target }, "monitor: website fetch failed");

        return { status: "down", latencyMs: null, httpStatus: null, detail };
    }

    const { response, latencyMs } = fetched;
    const statusLine = `${response.status} ${response.statusText}`.trim();
    const expected = watcher.config.expectStatus;
    const statusOk = expected !== undefined ? response.status === expected : response.status < 400;

    if (!statusOk) {
        const want = expected !== undefined ? `expected ${expected}` : "expected < 400";

        return {
            status: "down",
            latencyMs,
            httpStatus: response.status,
            detail: `${statusLine} (${want}) · ${latencyMs} ms`,
        };
    }

    if (watcher.config.expectBody && method !== "HEAD") {
        const body = await response.text();

        if (!body.includes(watcher.config.expectBody)) {
            return {
                status: "down",
                latencyMs,
                httpStatus: response.status,
                detail: `${statusLine} but body lacks "${watcher.config.expectBody}" · ${latencyMs} ms`,
            };
        }
    }

    const threshold = watcher.config.degradedAboveMs;

    if (threshold !== undefined && latencyMs > threshold) {
        return {
            status: "degraded",
            latencyMs,
            httpStatus: response.status,
            detail: `${statusLine} · ${latencyMs} ms (slower than ${threshold} ms)`,
        };
    }

    return { status: "up", latencyMs, httpStatus: response.status, detail: `${statusLine} · ${latencyMs} ms` };
}
