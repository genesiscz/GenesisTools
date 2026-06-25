import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { getAiProxyStorage } from "@app/ai-proxy/lib/storage";
import type {
    AccountBillingSnapshot,
    BillingUsageStore,
    DailyModelUsage,
    DailyUsageStore,
    GrokUsageDetails,
    UsageRequestRecord,
} from "@app/ai-proxy/lib/usage/types";
import { logger } from "@app/logger";
import type { GrokBillingConfig, GrokSettings } from "@app/utils/ai/grok";
import { SafeJSON } from "@app/utils/json";
import { atomicWriteFileSync } from "@app/utils/storage/storage";

const BILLING_TTL_MS = 5 * 60 * 1000;

let billingStoreCache: BillingUsageStore | null = null;

function usageDir(): string {
    return join(getAiProxyStorage().getBaseDir(), "usage");
}

function billingPath(): string {
    return join(usageDir(), "billing.json");
}

function dailyPath(): string {
    return join(usageDir(), "daily.json");
}

function requestsPath(): string {
    return join(usageDir(), "requests.jsonl");
}

function ensureUsageDir(): void {
    const dir = usageDir();

    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}

function emptyBillingStore(): BillingUsageStore {
    return { version: 1, accounts: {} };
}

function emptyDailyStore(): DailyUsageStore {
    return { version: 1, days: {} };
}

type LegacyBillingSnapshot = AccountBillingSnapshot & {
    billing?: GrokBillingConfig;
    settings?: GrokSettings;
};

function migrateBillingSnapshot(snapshot: LegacyBillingSnapshot): AccountBillingSnapshot {
    if (snapshot.grok || !snapshot.billing) {
        const { billing: _billing, settings: _settings, ...rest } = snapshot;
        return rest;
    }

    const { billing, settings, ...rest } = snapshot;
    const grok: GrokUsageDetails = { billing, ...(settings ? { settings } : {}) };

    return { ...rest, grok };
}

function migrateBillingStore(store: BillingUsageStore): BillingUsageStore {
    const accounts: BillingUsageStore["accounts"] = {};

    for (const [accountName, snapshot] of Object.entries(store.accounts)) {
        accounts[accountName] = migrateBillingSnapshot(snapshot as LegacyBillingSnapshot);
    }

    return { ...store, accounts };
}

function readJsonFile<T>(path: string, fallback: T): T {
    if (!existsSync(path)) {
        return fallback;
    }

    try {
        return SafeJSON.parse(readFileSync(path, "utf-8")) as T;
    } catch (err) {
        logger.warn({ err, path }, "ai-proxy usage: failed to read store file");
        return fallback;
    }
}

function writeJsonFile(path: string, value: unknown): void {
    ensureUsageDir();
    atomicWriteFileSync(path, `${SafeJSON.stringify(value, null, 2)}\n`);
}

let dailyStoreCache: DailyUsageStore | null = null;
let isWritingDailyStore = false;
let dailyStorePendingWrite = false;

function getDailyStore(): DailyUsageStore {
    if (!dailyStoreCache) {
        dailyStoreCache = readJsonFile(dailyPath(), emptyDailyStore());
    }

    return dailyStoreCache;
}

async function saveDailyStoreAsync(): Promise<void> {
    if (isWritingDailyStore) {
        dailyStorePendingWrite = true;
        return;
    }

    isWritingDailyStore = true;

    try {
        ensureUsageDir();
        await Bun.write(dailyPath(), `${SafeJSON.stringify(dailyStoreCache, null, 2)}\n`);
    } catch (err) {
        logger.warn({ err }, "ai-proxy usage: failed to write daily store");
    } finally {
        isWritingDailyStore = false;

        if (dailyStorePendingWrite) {
            dailyStorePendingWrite = false;
            void saveDailyStoreAsync();
        }
    }
}

function dayKey(date = new Date()): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
}

function aggregateKey(account: string, proxyModel: string): string {
    return `${account}/${proxyModel}`;
}

function bumpDailyAggregate(record: UsageRequestRecord): void {
    const store = getDailyStore();
    const day = dayKey(new Date(record.ts));
    const key = aggregateKey(record.account, record.proxyModel);

    if (!store.days[day]) {
        store.days[day] = {};
    }

    const current = store.days[day][key] ?? {
        requests: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        errors: 0,
        rate_limits: 0,
    };

    current.requests += 1;

    if (record.usage?.prompt_tokens) {
        current.prompt_tokens += record.usage.prompt_tokens;
    }

    if (record.usage?.completion_tokens) {
        current.completion_tokens += record.usage.completion_tokens;
    }

    if (record.usage?.total_tokens) {
        current.total_tokens += record.usage.total_tokens;
    }

    if (record.error) {
        current.errors += 1;
    }

    if (record.rateLimited) {
        current.rate_limits += 1;
    }

    store.days[day][key] = current;
    void saveDailyStoreAsync();
}

export function recordUsageRequest(record: UsageRequestRecord): void {
    ensureUsageDir();
    appendFileSync(requestsPath(), `${SafeJSON.stringify(record)}\n`);
    bumpDailyAggregate(record);

    logger.debug(
        {
            account: record.account,
            model: record.proxyModel,
            status: record.status,
            usage: record.usage,
            rateLimited: record.rateLimited,
        },
        "ai-proxy usage: recorded request"
    );
}

export function saveBillingSnapshot(accountName: string, snapshot: AccountBillingSnapshot): void {
    const store = readBillingStore();
    store.accounts[accountName] = snapshot;
    writeJsonFile(billingPath(), store);
    billingStoreCache = store;

    logger.info({ account: accountName, summary: snapshot.summary }, "ai-proxy usage: billing snapshot saved");
}

export function readBillingStore(): BillingUsageStore {
    if (billingStoreCache) {
        return billingStoreCache;
    }

    billingStoreCache = migrateBillingStore(readJsonFile(billingPath(), emptyBillingStore()));
    return billingStoreCache;
}

export function readDailyStore(): DailyUsageStore {
    return getDailyStore();
}

export function billingSnapshotIsStale(snapshot?: AccountBillingSnapshot, maxAgeMs = BILLING_TTL_MS): boolean {
    if (!snapshot?.fetchedAt) {
        return true;
    }

    const fetchedAtMs = Date.parse(snapshot.fetchedAt);
    if (!Number.isFinite(fetchedAtMs)) {
        return true;
    }

    return Date.now() - fetchedAtMs > maxAgeMs;
}

function parseRequestRecord(line: string): UsageRequestRecord | null {
    try {
        return SafeJSON.parse(line) as UsageRequestRecord;
    } catch (err) {
        logger.debug({ err, line }, "ai-proxy usage: skipped corrupt requests.jsonl line");
        return null;
    }
}

const NEWLINE_BYTE = 0x0a;

function collectTailJsonlRecords(
    path: string,
    limit: number,
    predicate?: (record: UsageRequestRecord) => boolean
): UsageRequestRecord[] {
    const fd = openSync(path, "r");

    try {
        const size = fstatSync(fd).size;
        if (size === 0) {
            return [];
        }

        const chunkSize = 64 * 1024;
        let position = size;
        let pending = Buffer.alloc(0);
        const records: UsageRequestRecord[] = [];

        const considerLine = (lineBuffer: Buffer): boolean => {
            const line = lineBuffer.toString("utf-8").trim();
            if (!line) {
                return false;
            }

            const record = parseRequestRecord(line);
            if (!record) {
                return false;
            }

            if (predicate && !predicate(record)) {
                return false;
            }

            records.unshift(record);
            return records.length >= limit;
        };

        while (position > 0 && records.length < limit) {
            const readSize = Math.min(chunkSize, position);
            position -= readSize;
            const chunk = Buffer.alloc(readSize);
            readSync(fd, chunk, 0, readSize, position);

            const buffer = Buffer.concat([chunk, pending]);
            let scanEnd = buffer.length;

            while (scanEnd > 0 && records.length < limit) {
                let scanStart = scanEnd - 1;

                while (scanStart >= 0 && buffer[scanStart] !== NEWLINE_BYTE) {
                    scanStart -= 1;
                }

                const line = buffer.subarray(scanStart + 1, scanEnd);
                if (line.length > 0 && considerLine(line)) {
                    break;
                }

                scanEnd = scanStart;
            }

            pending = buffer.subarray(0, Math.max(scanEnd, 0));
        }

        if (pending.length > 0 && records.length < limit) {
            considerLine(pending);
        }

        return records.slice(-limit);
    } finally {
        closeSync(fd);
    }
}

export function readRecentRequests(limit = 20): UsageRequestRecord[] {
    const path = requestsPath();

    if (!existsSync(path)) {
        return [];
    }

    return collectTailJsonlRecords(path, limit);
}

export function readRecentRequestsForAccount(account: string, limit = 20): UsageRequestRecord[] {
    const path = requestsPath();

    if (!existsSync(path)) {
        return [];
    }

    return collectTailJsonlRecords(path, limit, (record) => record.account === account);
}

export function getTodayUsageSummary(account?: string): DailyModelUsage {
    const store = readDailyStore();
    const today = store.days[dayKey()] ?? {};
    const summary: DailyModelUsage = {
        requests: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        errors: 0,
        rate_limits: 0,
    };

    for (const [key, stats] of Object.entries(today)) {
        if (account && !key.startsWith(`${account}/`)) {
            continue;
        }

        summary.requests += stats.requests;
        summary.prompt_tokens += stats.prompt_tokens;
        summary.completion_tokens += stats.completion_tokens;
        summary.total_tokens += stats.total_tokens;
        summary.errors += stats.errors;
        summary.rate_limits += stats.rate_limits;
    }

    return summary;
}

export function usageStorePaths(): { billing: string; daily: string; requests: string } {
    ensureUsageDir();

    return {
        billing: billingPath(),
        daily: dailyPath(),
        requests: requestsPath(),
    };
}
