import { type ClientLedgerStore, readClientLedger } from "@app/ai-proxy/lib/usage/client-ledger";
import { readDailyStore } from "@app/ai-proxy/lib/usage/store";
import type { DailyUsageStore } from "@app/ai-proxy/lib/usage/types";
import { daysBefore, localDayString } from "@genesiscz/utils/ai/usage/spend/monitor";

export function proxySinceDay(now: Date, days: number): string {
    return localDayString(daysBefore(now, days - 1));
}


/**
 * `tools ai-spend proxy` (design 2026-11-01, step U11, proposal 19): what the ai-proxy served, per client and month
 * from its client ledger, and per account and day from its daily store. Cost is the ledger's booked `cost_usd`,
 * printed as stored and never recomputed (`.claude/rules/ai.md`: the proxy books cost at write time).
 */
export interface ProxyClientMonth {
    month: string;
    client: string;
    requests: number;
    totalTokens: number;
    costUsd: number;
    unpricedRequests: number;
}

export interface ProxyAccountDay {
    day: string;
    account: string;
    requests: number;
    totalTokens: number;
    rateLimited: number;
    errors: number;
    /** Cache reads of the input the proxy saw, 0..1; null when no row recorded the split. */
    cacheReadShare: number | null;
}

export interface ProxyReport {
    clients: ProxyClientMonth[];
    accounts: ProxyAccountDay[];
}

export function proxyClientMonths(ledger: ClientLedgerStore, months?: ReadonlySet<string>): ProxyClientMonth[] {
    const rows: ProxyClientMonth[] = [];

    for (const [month, clients] of Object.entries(ledger.months)) {
        if (months && !months.has(month)) {
            continue;
        }

        for (const [client, usage] of Object.entries(clients)) {
            rows.push({
                month,
                client,
                requests: usage.requests,
                totalTokens: usage.total_tokens,
                costUsd: usage.cost_usd,
                unpricedRequests: usage.unpriced_requests,
            });
        }
    }

    return rows.sort((a, b) => b.month.localeCompare(a.month) || b.costUsd - a.costUsd);
}

/** Per account and day, the proxy's `account/model` keys summed over models. */
export function proxyAccountDays(store: DailyUsageStore, sinceDay: string): ProxyAccountDay[] {
    const rows = new Map<string, ProxyAccountDay & { cacheRead: number; input: number }>();

    for (const [day, keys] of Object.entries(store.days)) {
        if (day < sinceDay) {
            continue;
        }

        for (const [key, usage] of Object.entries(keys)) {
            const account = key.split("/")[0] ?? key;
            const id = `${day}\u0000${account}`;
            const row = rows.get(id) ?? {
                day,
                account,
                requests: 0,
                totalTokens: 0,
                rateLimited: 0,
                errors: 0,
                cacheReadShare: null,
                cacheRead: 0,
                input: 0,
            };
            row.requests += usage.requests;
            row.totalTokens += usage.total_tokens;
            row.rateLimited += usage.rate_limits;
            row.errors += usage.errors;

            if (usage.cache_read_tokens !== undefined) {
                row.cacheRead += usage.cache_read_tokens;
                row.input +=
                    usage.cache_read_tokens + (usage.cache_write_tokens ?? 0) + (usage.uncached_input_tokens ?? 0);
            }

            rows.set(id, row);
        }
    }

    return [...rows.values()]
        .map(({ cacheRead, input, ...row }) => ({ ...row, cacheReadShare: input > 0 ? cacheRead / input : null }))
        .sort((a, b) => b.day.localeCompare(a.day) || a.account.localeCompare(b.account));
}

export function buildProxyReport(options: { months?: ReadonlySet<string>; sinceDay: string }): ProxyReport {
    return {
        clients: proxyClientMonths(readClientLedger(), options.months),
        accounts: proxyAccountDays(readDailyStore(), options.sinceDay),
    };
}
