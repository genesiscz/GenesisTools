import { checkDomains } from "@app/domains/lib/check";
import { parseDomain } from "@app/domains/lib/domain";
import { storage } from "@app/domains/lib/http";
import type { CheckResult, DomainStatus } from "@app/domains/lib/types";
import { logger } from "@genesiscz/utils/logger";
import type { WatchItemLine } from "@genesiscz/utils/watch/items";

export interface WatchEntry {
    domain: string;
    addedAt: string;
    note?: string;
    lastStatus?: DomainStatus;
    lastCheckedAt?: string;
    /** When the refresh that wrote the last state started; an older refresh never overwrites it. */
    observedAt?: string;
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
    /** The same reasons with their stable keys (the `--items` output). */
    facts: ChangeFact[];
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

/** One reason a watched name is worth a look, with a key that stays the same while the fact does. */
export interface ChangeFact {
    /** Stable across refreshes for the same fact: `status:taken`, `available`, `expires:2026-12-01`, `price:12.5`. */
    key: string;
    text: string;
}

export function changeFacts({
    entry,
    result,
    now,
    expiryWarnDays,
}: {
    entry: WatchEntry;
    result: CheckResult;
    now: Date;
    expiryWarnDays: number;
}): ChangeFact[] {
    const facts: ChangeFact[] = [];
    // "unknown" means no provider could decide this time; it is not a change of state.
    if (entry.lastStatus && result.status !== "unknown" && entry.lastStatus !== result.status) {
        facts.push({ key: `status:${result.status}`, text: `${entry.lastStatus} -> ${result.status}` });
    }

    if (result.status === "available" && entry.lastStatus !== "available") {
        facts.push({ key: "available", text: "now available" });
    }

    // A check without registration details keeps the saved expiry while the name is still registered.
    const registered = (status?: DomainStatus) => status === "taken" || status === "for-sale";
    const stillRegistered = registered(result.status) || (result.status === "unknown" && registered(entry.lastStatus));
    const expiresAt = result.expiresAt ?? (stillRegistered ? entry.expiresAt : undefined);
    if (expiresAt) {
        const days = Math.floor((Date.parse(expiresAt) - now.getTime()) / DAY_MS);
        if (days <= expiryWarnDays) {
            // The text counts down every day; the key is the expiry date, so a watcher hears it once per date.
            facts.push({
                key: `expires:${expiresAt.slice(0, 10)}`,
                text: days < 0 ? `expired ${-days} days ago` : `expires in ${days} days`,
            });
        }
    }

    const price = result.price?.registration;
    if (price !== undefined && entry.price !== undefined && Math.abs(price - entry.price) > 0.01) {
        facts.push({ key: `price:${price}`, text: `price ${entry.price} -> ${price}` });
    }

    const seen = new Set<string>();
    return facts.filter((fact) => !seen.has(fact.text) && seen.add(fact.text));
}

export function changeReasons(input: Parameters<typeof changeFacts>[0]): string[] {
    return changeFacts(input).map((fact) => fact.text);
}

/**
 * A refresh's news as Monitor item lines (`tools domains watch refresh --items`, mobile plan M12): one item per
 * fact, keyed by the domain and the fact's key, so a name that keeps expiring in N days is one item, not one a day.
 */
export function watchItems(changes: readonly WatchChange[]): WatchItemLine[] {
    return changes.flatMap((change) =>
        change.facts.map((fact) => ({
            guid: `${change.entry.domain}:${fact.key}`,
            title: `${change.entry.domain} ${fact.text}`,
            summary: change.entry.note ?? null,
            publishedAt: change.result.checkedAt,
        }))
    );
}

/**
 * Store what one refresh saw and return the changes it stored. It skips an entry that a refresh started later
 * already wrote (two refreshes overlapping, the older finishing last) and an entry removed and added again since
 * this refresh read it.
 */
export function applyObservations(watch: WatchEntry[], changes: WatchChange[], observedAt: string): WatchChange[] {
    const accepted: WatchChange[] = [];
    for (const change of changes) {
        const stored = watch.find((entry) => entry.domain === change.entry.domain);
        if (!stored || stored.addedAt !== change.entry.addedAt || (stored.observedAt ?? "") > observedAt) {
            continue;
        }

        accepted.push(change);

        const { status, checkedAt, expiresAt, price } = change.result;
        stored.lastCheckedAt = checkedAt;
        stored.observedAt = observedAt;
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

    return accepted;
}

/** Re-check every watched name (fresh, with RDAP details), store the new state, return what changed. */
export async function refreshWatch({ expiryWarnDays = 45 }: { expiryWarnDays?: number } = {}): Promise<WatchChange[]> {
    const entries = await listWatch();
    const now = new Date();
    const observedAt = now.toISOString();
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

        const facts = changeFacts({ entry, result, now, expiryWarnDays });
        changes.push({ entry, result, previous: entry.lastStatus, reasons: facts.map((fact) => fact.text), facts });
    }

    // Only what was stored is reported: a refresh that lost to a newer one, or a name removed meanwhile, says nothing.
    let accepted: WatchChange[] = [];
    await storage.atomicConfigUpdate<DomainsConfig>((config) => {
        accepted = applyObservations(config.watch ?? [], changes, observedAt);
    });
    logger.debug({ checked: changes.length, stored: accepted.length }, "domains: watch check stored");
    return accepted;
}
