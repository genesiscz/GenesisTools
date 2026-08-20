import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { estimateCostUsd } from "@app/ai-proxy/lib/billing/pricing";
import type { ResolvedClient } from "@app/ai-proxy/lib/clients";
import { getAiProxyStorage } from "@app/ai-proxy/lib/storage";
import { emitProxyUsage } from "@app/ai-proxy/lib/usage/usage-events";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

export interface ClientMonthUsage {
    requests: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost_usd: number;
    /** Count of requests whose model had no pricing entry (cost under-estimated). */
    unpriced_requests: number;
    /**
     * Of `requests`, how many were booked from the UPSTREAM's own reported charge
     * rather than from the local rate table. Keeps "how much of this invoice is
     * exact?" answerable after the fact.
     */
    upstream_priced_requests?: number;
    /**
     * Of `requests`, how many had their tokens char-estimated because the
     * upstream streamed no usage. Quotas enforce against this file, so an
     * invoice reader must be able to tell a measurement from a guess here too,
     * not only in daily.json.
     */
    estimated_requests?: number;
}

export interface ClientLedgerStore {
    version: 1;
    months: Record<string, Record<string, ClientMonthUsage>>;
}

let dirOverride: string | null = null;
let cachedLedger: ClientLedgerStore | null = null;

/** Test hook — point the ledger at a temp dir. Pass null to restore. */
export function setClientLedgerDirForTests(dir: string | null): void {
    dirOverride = dir;
    cachedLedger = null;
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
    if (cachedLedger) {
        return cachedLedger;
    }

    const path = ledgerPath();

    if (!existsSync(path)) {
        cachedLedger = emptyLedger();
        return cachedLedger;
    }

    try {
        const parsed = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as ClientLedgerStore;

        if (typeof parsed !== "object" || parsed === null || typeof parsed.months !== "object" || !parsed.months) {
            throw new Error("ledger file has no months object");
        }

        cachedLedger = parsed;
        return cachedLedger;
    } catch (err) {
        logger.warn({ err, path }, "ai-proxy: client ledger unreadable, starting fresh");
        cachedLedger = emptyLedger();
        return cachedLedger;
    }
}

function emptyMonthUsage(): ClientMonthUsage {
    return { requests: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0, unpriced_requests: 0 };
}

export function recordClientUsage(input: {
    client: string;
    ts: string;
    upstreamModel: string;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        /** The upstream's own reported charge, when it reports one. */
        cost_usd?: number;
        /** Set when the tokens are a char heuristic, not an upstream report. */
        source?: "estimated";
    };
    /** The account billed upstream. Absent only where no route is known (tests). */
    accountId?: string;
    provider?: string;
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

    if (input.usage?.source === "estimated") {
        entry.estimated_requests = (entry.estimated_requests ?? 0) + 1;
    }

    // The upstream's own number first: it prices the route actually taken, at the
    // rate actually charged, including a provider this proxy has no rate table
    // for. The local estimate stays the fallback. The write-time invariant is
    // unchanged — cost is still computed once, here, from data captured on THIS
    // exchange, so a later rate edit can never rewrite a past invoice.
    const upstreamCost = input.usage?.cost_usd;
    const usedUpstream = typeof upstreamCost === "number" && Number.isFinite(upstreamCost) && upstreamCost >= 0;
    const cost = usedUpstream ? upstreamCost : estimateCostUsd(input.upstreamModel, input.usage ?? {});

    if (cost === undefined) {
        entry.unpriced_requests += 1;
        // Live model discovery can outrun the rate table, so say which id billed
        // nothing. Here rather than at listing time: this fires once per real
        // call, in the serve process, instead of on every CLI that lists models.
        logger.warn(
            { model: input.upstreamModel, client: input.client, rateTable: "src/ai-proxy/lib/billing/pricing.ts" },
            "ai-proxy: no billing rate for this model — tokens recorded, $0 booked"
        );
    } else {
        entry.cost_usd += cost;
    }

    if (usedUpstream) {
        entry.upstream_priced_requests = (entry.upstream_priced_requests ?? 0) + 1;
    }

    atomicWriteFileSync(ledgerPath(), SafeJSON.stringify(ledger, null, 2) ?? "{}");

    // AFTER the invoice is on disk, and carrying the cost this ledger just
    // booked, so the shared layer mirrors the invoice rather than re-deriving it.
    if (input.accountId && input.provider) {
        emitProxyUsage({
            app: "ai-proxy",
            at: input.ts,
            accountId: input.accountId,
            provider: input.provider,
            modelId: input.upstreamModel,
            inputTokens: input.usage?.prompt_tokens ?? 0,
            outputTokens: input.usage?.completion_tokens ?? 0,
            ...(cost === undefined ? {} : { costUsd: cost }),
            meta: { kind: "proxy-request", client: input.client },
        });
    }
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
