import { logger } from "@app/logger";
import { startWakefulInterval, type WakefulInterval } from "@app/utils/async";
import { SafeJSON } from "@app/utils/json";
import { collectPulse } from "./collector";
import { PulseHistoryDb } from "./history-db";
import type { PulseSeries, PulseSnapshot } from "./types";

const PUBLIC_IP_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_RETENTION_HOURS = 24;
const IDLE_THRESHOLD_MS = 60_000;

interface IpifyResponse {
    ip?: string;
}

let handle: WakefulInterval | null = null;
let polling = false;
let db: PulseHistoryDb | null = null;
let lastSnapshot: PulseSnapshot | null = null;
let retentionHours = DEFAULT_RETENTION_HOURS;
let lastClientSeenAt = 0;

export interface PulsePollingOptions {
    collectOverride?: () => Promise<PulseSnapshot>;
}

export function markPulseClientSeen(): void {
    lastClientSeenAt = Date.now();
}

function getDb(): PulseHistoryDb {
    if (!db) {
        db = new PulseHistoryDb();
    }

    return db;
}

async function refreshPublicIp(history: PulseHistoryDb): Promise<string | null> {
    const cached = history.getPublicIp(PUBLIC_IP_MAX_AGE_MS);

    if (cached) {
        return cached;
    }

    try {
        const res = await fetch("https://api.ipify.org?format=json", {
            signal: AbortSignal.timeout(4000),
        });

        if (!res.ok) {
            return history.getPublicIp(Number.POSITIVE_INFINITY);
        }

        const json = SafeJSON.parse(await res.text(), { strict: true }) as IpifyResponse;

        if (json.ip) {
            history.setPublicIp(json.ip);
            return json.ip;
        }
    } catch (err) {
        logger.debug({ err }, "ipify public IP refresh failed");
        return history.getPublicIp(Number.POSITIVE_INFINITY);
    }

    return history.getPublicIp(Number.POSITIVE_INFINITY);
}

async function tick(): Promise<void> {
    if (polling) {
        return;
    }

    polling = true;
    const history = getDb();

    try {
        const snapshot = await collectPulse();
        const publicIp = await refreshPublicIp(history);
        snapshot.publicIp = publicIp;
        lastSnapshot = snapshot;

        if (snapshot.cpuPct !== null) {
            history.record("cpu", snapshot.cpuPct);
        }

        if (snapshot.memFreePct !== null) {
            history.record("mem_free", snapshot.memFreePct);
        }

        if (snapshot.swapUsedBytes !== null && snapshot.swapTotalBytes) {
            history.record("swap", (snapshot.swapUsedBytes / snapshot.swapTotalBytes) * 100);
        }

        if (snapshot.batteryPct !== null) {
            history.record("battery", snapshot.batteryPct);
        }

        history.pruneOlderThan(retentionHours);
    } catch (err) {
        logger.debug({ err }, "pulse tick failed; keeping last good snapshot");
    } finally {
        polling = false;
    }
}

export function startPulsePolling(intervalMs: number, opts: PulsePollingOptions = {}): void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        logger.warn({ intervalMs }, "pulse polling not started: invalid interval");
        return;
    }

    if (handle) {
        return;
    }

    handle = startWakefulInterval(intervalMs, async () => {
        if (Date.now() - lastClientSeenAt > IDLE_THRESHOLD_MS) {
            return;
        }

        if (opts.collectOverride) {
            polling = true;

            try {
                lastSnapshot = await opts.collectOverride();
            } catch (err) {
                logger.debug({ err }, "pulse tick failed; keeping last good snapshot");
            } finally {
                polling = false;
            }

            return;
        }

        await tick();
    });
}

export function stopPulsePolling(): void {
    if (!handle) {
        return;
    }

    handle.stop();
    handle = null;
}

export function configureRetention(hours: number): void {
    retentionHours = hours;
}

export function getCachedPulse(): PulseSnapshot | null {
    return lastSnapshot;
}

export function getSeries(metric: string, minutes: number): PulseSeries {
    return { metric, points: getDb().series(metric, minutes) };
}
