import { checkDomains } from "@app/domains/lib/check";
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
    // "unknown" means no provider could decide this time; it is not a change of state.
    if (entry.lastStatus && result.status !== "unknown" && entry.lastStatus !== result.status) {
        reasons.push(`${entry.lastStatus} -> ${result.status}`);
    }

    if (result.status === "available" && entry.lastStatus !== "available") {
        reasons.push("now available");
    }

    // A check without registration details keeps the saved expiry while the name is still registered.
    const registered = (status?: DomainStatus) => status === "taken" || status === "for-sale";
    const stillRegistered = registered(result.status) || (result.status === "unknown" && registered(entry.lastStatus));
    const expiresAt = result.expiresAt ?? (stillRegistered ? entry.expiresAt : undefined);
    if (expiresAt) {
        const days = Math.floor((Date.parse(expiresAt) - now.getTime()) / DAY_MS);
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
    const { results } = await checkDomains(
        entries.map((entry) => entry.domain),
        { fresh: true, details: true }
    );
    const byDomain = new Map(results.map((result) => [result.domain, result]));
    const changes: WatchChange[] = [];
    for (const entry of entries) {
        const result = byDomain.get(parseDomain(entry.domain)?.domain ?? entry.domain);
        if (!result) {
            continue;
        }

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

            const { status, checkedAt, expiresAt, price } = change.result;
            stored.lastCheckedAt = checkedAt;
            if (status === "unknown") {
                continue;
            }

            stored.lastStatus = status;
            if (expiresAt) {
                stored.expiresAt = expiresAt;
            } else if (status === "available" || status === "premium") {
                // A registrable name has no expiry; the old one belonged to the previous owner.
                stored.expiresAt = undefined;
            }

            if (price) {
                stored.price = price.registration;
            }
        }
    });
    logger.debug({ checked: changes.length }, "domains: watch check stored");
    return changes;
}
