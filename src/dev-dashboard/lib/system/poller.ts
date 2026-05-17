import logger from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { collectPulse } from "./collector";
import { PulseHistoryDb } from "./history-db";
import type { PulseSeries, PulseSnapshot } from "./types";

const PUBLIC_IP_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_RETENTION_HOURS = 24;

interface IpifyResponse {
    ip?: string;
}

let timer: ReturnType<typeof setInterval> | null = null;
let polling = false;
let db: PulseHistoryDb | null = null;
let lastSnapshot: PulseSnapshot | null = null;
let retentionHours = DEFAULT_RETENTION_HOURS;

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

        if (snapshot.memUsedBytes !== null && snapshot.memTotalBytes) {
            history.record("mem", (snapshot.memUsedBytes / snapshot.memTotalBytes) * 100);
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

export function startPulsePolling(intervalMs: number): void {
    if (timer) {
        return;
    }

    void tick();
    timer = setInterval(() => {
        void tick();
    }, intervalMs);
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
