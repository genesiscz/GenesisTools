import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { CheckResult, Watcher } from "../types";
import { describeFetchError, timedFetch } from "./http";

const MAX_JSON_BYTES = 2 * 1024 * 1024;

/** `a.b[0].c` or `a.b.0.c`; an empty path is the whole document. */
export function getPath(value: unknown, path: string): unknown {
    const parts = path
        .replace(/\[(\d+)\]/g, ".$1")
        .split(".")
        .map((part) => part.trim())
        .filter(Boolean);
    let current: unknown = value;

    for (const part of parts) {
        if (current === null || typeof current !== "object") {
            return undefined;
        }

        current = (current as Record<string, unknown>)[part];
    }

    return current;
}

export function renderValue(value: unknown): string {
    if (value === undefined) {
        return "undefined";
    }

    if (typeof value === "string") {
        return value;
    }

    return SafeJSON.stringify(value, { strict: true }).slice(0, 120);
}

/**
 * Fetches JSON and reads one path: with `expect` the value must equal it (as
 * text), without it the path only has to exist. `expectStatus` works as for
 * website watchers.
 */
export async function checkJson(watcher: Pick<Watcher, "target" | "config" | "timeoutMs">): Promise<CheckResult> {
    const headers: Record<string, string> = {
        Accept: "application/json",
        "User-Agent": "genesis-tools-monitor/1.0",
        ...watcher.config.headers,
    };
    let response: Response;
    let latencyMs: number;

    try {
        ({ response, latencyMs } = await timedFetch(
            watcher.target,
            { method: watcher.config.method === "POST" ? "POST" : "GET", headers },
            watcher.timeoutMs
        ));
    } catch (error) {
        logger.debug({ error, target: watcher.target }, "monitor: json fetch failed");

        return {
            status: "down",
            latencyMs: null,
            httpStatus: null,
            detail: describeFetchError(error, watcher.timeoutMs),
        };
    }

    const statusLine = `${response.status} ${response.statusText}`.trim();
    const expectedStatus = watcher.config.expectStatus;
    const statusOk = expectedStatus !== undefined ? response.status === expectedStatus : response.status < 400;

    if (!statusOk) {
        await response.body?.cancel();

        return { status: "down", latencyMs, httpStatus: response.status, detail: `${statusLine} · ${latencyMs} ms` };
    }

    const declared = Number(response.headers.get("content-length") ?? "");

    if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
        await response.body?.cancel();

        return {
            status: "down",
            latencyMs,
            httpStatus: response.status,
            detail: "response larger than 2 MB, not parsed",
        };
    }

    let document: unknown;

    try {
        document = SafeJSON.parse(await response.text(), { strict: true });
    } catch (error) {
        logger.debug({ error, target: watcher.target }, "monitor: json body unreadable");

        return {
            status: "down",
            latencyMs,
            httpStatus: response.status,
            detail: `${statusLine} but the body is not JSON`,
        };
    }

    const path = watcher.config.jsonPath ?? "";
    const value = getPath(document, path);
    const shown = path ? `${path} = ${renderValue(value)}` : renderValue(value);
    const meta = { path, value: value === undefined ? null : value };

    if (value === undefined) {
        return {
            status: "down",
            latencyMs,
            httpStatus: response.status,
            detail: `${path || "document"} is missing`,
            meta,
        };
    }

    const expect = watcher.config.expect;

    if (expect !== undefined && renderValue(value) !== expect) {
        return {
            status: "down",
            latencyMs,
            httpStatus: response.status,
            detail: `${shown} (expected ${expect}) · ${latencyMs} ms`,
            meta,
        };
    }

    const threshold = watcher.config.degradedAboveMs;

    if (threshold !== undefined && latencyMs > threshold) {
        return {
            status: "degraded",
            latencyMs,
            httpStatus: response.status,
            detail: `${shown} · ${latencyMs} ms (slower than ${threshold} ms)`,
            meta,
        };
    }

    return { status: "up", latencyMs, httpStatus: response.status, detail: `${shown} · ${latencyMs} ms`, meta };
}
