import { logger } from "@app/logger";

const PING_TIMEOUT_MS = 3000;

/**
 * Round-trip ms of a lightweight self-ping to the agent's own HTTP surface. Used to classify link
 * health. Returns null on timeout / network error (the classifier maps null → "down"). We GET the
 * cheap `/api/system/pulse` path (already served, no side effects) rather than adding a /healthz.
 */
export async function selfPingMs(baseUrl: string): Promise<number | null> {
    const url = `${baseUrl.replace(/\/+$/, "")}/api/system/pulse`;
    const start = performance.now();

    try {
        const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(PING_TIMEOUT_MS) });

        if (!res.ok) {
            logger.debug({ status: res.status, url }, "net selfPing non-2xx");
            return null;
        }

        await res.arrayBuffer();
        return Math.round(performance.now() - start);
    } catch (err) {
        logger.debug({ err, url }, "net selfPing failed");
        return null;
    }
}
