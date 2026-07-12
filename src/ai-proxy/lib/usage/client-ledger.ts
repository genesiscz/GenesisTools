import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { estimateCostUsd } from "@app/ai-proxy/lib/billing/pricing";
import type { ResolvedClient } from "@app/ai-proxy/lib/clients";
import { getAiProxyStorage } from "@app/ai-proxy/lib/storage";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { atomicWriteFileSync } from "@app/utils/storage/storage";

export interface ClientMonthUsage {
    requests: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost_usd: number;
    /** Count of requests whose model had no pricing entry (cost under-estimated). */
    unpriced_requests: number;
}

export interface ClientLedgerStore {
    version: 1;
    months: Record<string, Record<string, ClientMonthUsage>>;
}

let dirOverride: string | null = null;

/** Test hook — point the ledger at a temp dir. Pass null to restore. */
export function setClientLedgerDirForTests(dir: string | null): void {
    dirOverride = dir;
}

function ledgerDir(): string {
    return dirOverride ?? join(getAiProxyStorage().getBaseDir(), "usage");
}

function ledgerPath(): string {
    return join(ledgerDir(), "clients.json");
}

function emptyLedger(): ClientLedgerStore {
    return { version: 1, months: {} };
}

export function monthKeyFromTs(ts: string): string {
    return ts.slice(0, 7);
}

export function readClientLedger(): ClientLedgerStore {
    const path = ledgerPath();

    if (!existsSync(path)) {
        return emptyLedger();
    }

    try {
        return SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as ClientLedgerStore;
    } catch (err) {
        logger.warn({ err, path }, "ai-proxy: client ledger unreadable, starting fresh");
        return emptyLedger();
    }
}

function emptyMonthUsage(): ClientMonthUsage {
    return { requests: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0, unpriced_requests: 0 };
}

export function recordClientUsage(input: {
    client: string;
    ts: string;
    upstreamModel: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}): void {
    const dir = ledgerDir();

    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    const ledger = readClientLedger();
    const month = monthKeyFromTs(input.ts);
    let byClient = ledger.months[month];

    if (!byClient) {
        byClient = {};
        ledger.months[month] = byClient;
    }

    let entry = byClient[input.client];

    if (!entry) {
        entry = emptyMonthUsage();
        byClient[input.client] = entry;
    }

    entry.requests += 1;
    entry.prompt_tokens += input.usage?.prompt_tokens ?? 0;
    entry.completion_tokens += input.usage?.completion_tokens ?? 0;
    entry.total_tokens += input.usage?.total_tokens ?? 0;

    const cost = estimateCostUsd(input.upstreamModel, input.usage ?? {});

    if (cost === undefined) {
        entry.unpriced_requests += 1;
    } else {
        entry.cost_usd += cost;
    }

    atomicWriteFileSync(ledgerPath(), SafeJSON.stringify(ledger, null, 2) ?? "{}");
}

export function checkClientQuota(client: ResolvedClient): { ok: true } | { ok: false; reason: string } {
    if (client.isOwner || !client.config) {
        return { ok: true };
    }

    const { monthlyTokenCap, monthlyCostCapUsd } = client.config;

    if (monthlyTokenCap === undefined && monthlyCostCapUsd === undefined) {
        return { ok: true };
    }

    const month = monthKeyFromTs(new Date().toISOString());
    const usage = readClientLedger().months[month]?.[client.name];

    if (!usage) {
        return { ok: true };
    }

    if (monthlyTokenCap !== undefined && usage.total_tokens >= monthlyTokenCap) {
        return {
            ok: false,
            reason: `monthly token quota exceeded (${usage.total_tokens}/${monthlyTokenCap} tokens used in ${month})`,
        };
    }

    if (monthlyCostCapUsd !== undefined && usage.cost_usd >= monthlyCostCapUsd) {
        return {
            ok: false,
            reason: `monthly cost quota exceeded ($${usage.cost_usd.toFixed(2)}/$${monthlyCostCapUsd} in ${month})`,
        };
    }

    return { ok: true };
}
