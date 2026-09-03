import { promises as dns } from "node:dns";
import { withTimeout } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";
import type { CheckResult, Watcher } from "../types";

async function resolveAll(host: string): Promise<string[]> {
    const [v4, v6] = await Promise.allSettled([dns.resolve4(host), dns.resolve6(host)]);
    const addresses = [...(v4.status === "fulfilled" ? v4.value : []), ...(v6.status === "fulfilled" ? v6.value : [])];

    if (addresses.length === 0) {
        const reason = v4.status === "rejected" ? v4.reason : v6.status === "rejected" ? v6.reason : null;
        throw reason instanceof Error ? reason : new Error("no A or AAAA record");
    }

    return addresses;
}

/** Resolves the host; optionally requires one specific address among the answers. */
export async function checkDns(watcher: Pick<Watcher, "target" | "config" | "timeoutMs">): Promise<CheckResult> {
    const host = watcher.target;
    const started = performance.now();
    let addresses: string[];

    try {
        addresses = await withTimeout(resolveAll(host), watcher.timeoutMs);
    } catch (error) {
        logger.debug({ error, host }, "monitor: dns resolve failed");
        const message = error instanceof Error ? error.message : String(error);

        return { status: "down", latencyMs: null, httpStatus: null, detail: `${host}: ${message}` };
    }

    const latencyMs = Math.round(performance.now() - started);
    const list = addresses.slice(0, 4).join(", ") + (addresses.length > 4 ? ` +${addresses.length - 4}` : "");
    const expected = watcher.config.expectIp;

    if (expected && !addresses.includes(expected)) {
        return {
            status: "down",
            latencyMs,
            httpStatus: null,
            detail: `${host} resolves to ${list}, expected ${expected}`,
            meta: { addresses },
        };
    }

    const threshold = watcher.config.degradedAboveMs;

    if (threshold !== undefined && latencyMs > threshold) {
        return {
            status: "degraded",
            latencyMs,
            httpStatus: null,
            detail: `${host} → ${list} · ${latencyMs} ms (slower than ${threshold} ms)`,
            meta: { addresses },
        };
    }

    return {
        status: "up",
        latencyMs,
        httpStatus: null,
        detail: `${host} → ${list} · ${latencyMs} ms`,
        meta: { addresses },
    };
}
