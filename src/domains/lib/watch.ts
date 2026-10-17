import { checkDomain } from "@app/domains/lib/check";
import { parseDomain } from "@app/domains/lib/domain";
import { storage } from "@app/domains/lib/http";
import type { CheckResult, DomainStatus } from "@app/domains/lib/types";
import { logger } from "@genesiscz/utils/logger";

export interface WatchEntry {
    domain: string;
    addedAt: string;
    note?: string;
    lastStatus?: DomainStatus;
    lastCheckedAt?: string;
    expiresAt?: string;
    price?: number;
}

interface DomainsConfig {
    watch?: WatchEntry[];
}

export interface WatchChange {
    entry: WatchEntry;
    result: CheckResult;
    previous?: DomainStatus;
    /** Why it is worth a look: "now available", "expires in 12 days", "price changed". */
    reasons: string[];
}

export async function listWatch(): Promise<WatchEntry[]> {
    return (await storage.getConfig<DomainsConfig>())?.watch ?? [];
}

export async function addWatch(domains: string[], note?: string): Promise<{ added: string[]; invalid: string[] }> {
    const added: string[] = [];
    const invalid: string[] = [];
    await storage.atomicConfigUpdate<DomainsConfig>((config) => {
        config.watch ??= [];
        for (const input of domains) {
            const parsed = parseDomain(input);
            if (!parsed) {
                invalid.push(input);
                continue;
            }

            if (!config.watch.some((entry) => entry.domain === parsed.domain)) {
                config.watch.push({ domain: parsed.domain, addedAt: new Date().toISOString(), note });
                added.push(parsed.domain);
            }
        }
    });
    return { added, invalid };
}

export async function removeWatch(domains: string[]): Promise<string[]> {
    const wanted = new Set(domains.map((input) => parseDomain(input)?.domain ?? input.toLowerCase()));
    const removed: string[] = [];
    await storage.atomicConfigUpdate<DomainsConfig>((config) => {
        config.watch = (config.watch ?? []).filter((entry) => {
            if (wanted.has(entry.domain)) {
                removed.push(entry.domain);
                return false;
            }

            return true;
        });
    });
    return removed;
}

const DAY_MS = 86_400_000;

export function changeReasons({
    entry,
    result,
    now,
    expiryWarnDays,
}: {
    entry: WatchEntry;
    result: CheckResult;
    now: Date;
    expiryWarnDays: number;
}): string[] {
    const reasons: string[] = [];
    if (entry.lastStatus && entry.lastStatus !== result.status) {
        reasons.push(`${entry.lastStatus} -> ${result.status}`);
    }

    if (result.status === "available" && entry.lastStatus !== "available") {
        reasons.push("now available");
    }

    if (result.expiresAt) {
        const days = Math.floor((Date.parse(result.expiresAt) - now.getTime()) / DAY_MS);
        if (days <= expiryWarnDays) {
            reasons.push(days < 0 ? `expired ${-days} days ago` : `expires in ${days} days`);
        }
    }

    const price = result.price?.registration;
    if (price !== undefined && entry.price !== undefined && Math.abs(price - entry.price) > 0.01) {
        reasons.push(`price ${entry.price} -> ${price}`);
    }

    return [...new Set(reasons)];
}

/** Re-check every watched name (fresh, with RDAP details), store the new state, return what changed. */
export async function refreshWatch({ expiryWarnDays = 45 }: { expiryWarnDays?: number } = {}): Promise<WatchChange[]> {
    const entries = await listWatch();
    const now = new Date();
    const changes: WatchChange[] = [];
    for (const entry of entries) {
        const parsed = parseDomain(entry.domain);
        if (!parsed) {
            continue;
        }

        const result = await checkDomain(parsed, { fresh: true, details: true });
        changes.push({
            entry,
            result,
            previous: entry.lastStatus,
            reasons: changeReasons({ entry, result, now, expiryWarnDays }),
        });
    }

    await storage.atomicConfigUpdate<DomainsConfig>((config) => {
        for (const change of changes) {
            const stored = config.watch?.find((entry) => entry.domain === change.entry.domain);
            if (!stored) {
                continue;
            }

            stored.lastStatus = change.result.status;
            stored.lastCheckedAt = change.result.checkedAt;
            stored.expiresAt = change.result.expiresAt;
            stored.price = change.result.price?.registration;
        }
    });
    logger.debug({ checked: changes.length }, "domains: watch check stored");
    return changes;
}
