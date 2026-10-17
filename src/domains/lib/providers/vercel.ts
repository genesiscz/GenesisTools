import { request, storage } from "@app/domains/lib/http";
import type { DomainProvider } from "@app/domains/lib/providers/types";
import type { DomainPrice, ParsedDomain, ProviderVerdict } from "@app/domains/lib/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

const API = "https://api.vercel.com/v1/registrar";
/** The bulk search takes 1 to 200 names per call. */
const BATCH_SIZE = 200;

interface VercelPrice {
    years: number;
    purchasePrice: number | null;
    renewalPrice: number | null;
    transferPrice: number | null;
}

interface VercelSearchResult {
    domain: string;
    available: boolean;
    price?: number;
    renewalPrice?: number;
    premium?: boolean;
}

async function supportedTlds(): Promise<Set<string>> {
    const list = await storage.getFileOrPut<string[]>(
        "vercel/tlds.json",
        async () => {
            const response = await request<string[]>(`${API}/tlds/supported`, { label: "vercel tlds" });
            if (!Array.isArray(response.body)) {
                throw new Error(`Vercel TLD list failed: HTTP ${response.status}`);
            }

            return response.body;
        },
        "7 days"
    );
    return new Set(list);
}

function toVerdict(result: VercelSearchResult): ProviderVerdict {
    if (!result.available) {
        return { provider: "vercel", status: "taken" };
    }

    const price: DomainPrice | undefined =
        result.price !== undefined
            ? {
                  registration: result.price,
                  renewal: result.renewalPrice,
                  currency: "USD",
                  provider: "vercel",
                  premium: result.premium ?? false,
              }
            : undefined;
    return { provider: "vercel", status: result.premium ? "premium" : "available", price };
}

/**
 * Availability, price and the registry premium flag for up to 200 names per call, with no account.
 * Names on a TLD Vercel does not sell come back "not available", so callers filter with `supports()` first.
 */
export async function vercelSearch(domains: string[]): Promise<Map<string, ProviderVerdict>> {
    const verdicts = new Map<string, ProviderVerdict>();
    for (let i = 0; i < domains.length; i += BATCH_SIZE) {
        const batch = domains.slice(i, i + BATCH_SIZE);
        const response = await request<{ results?: VercelSearchResult[] }>(`${API}/domains/search`, {
            method: "POST",
            label: "vercel search",
            timeoutMs: 30_000,
            headers: { "content-type": "application/json" },
            body: SafeJSON.stringify({ domains: batch }, { strict: true }),
        });
        if (!response.body?.results) {
            logger.warn({ status: response.status, count: batch.length }, "domains: Vercel bulk search failed");
            continue;
        }

        for (const result of response.body.results) {
            verdicts.set(result.domain.toLowerCase(), toVerdict(result));
        }
    }

    return verdicts;
}

export const vercelProvider: DomainProvider = {
    id: "vercel",
    label: "Vercel Registrar (bulk, no auth)",
    capabilities: { availability: true, price: true, registration: false },

    async status() {
        return { configured: true, detail: "no auth; bulk search with premium flag" };
    },

    async supports(tld) {
        return (await supportedTlds()).has(tld);
    },

    async tldPrice(tld) {
        const price = await storage.getFileOrPut<VercelPrice | null>(
            `vercel/tld-price-${tld}.json`,
            async () => (await request<VercelPrice>(`${API}/tlds/${tld}/price`, { label: "vercel tld price" })).body,
            "1 day"
        );
        if (price?.purchasePrice === null || price?.purchasePrice === undefined) {
            return null;
        }

        return {
            registration: price.purchasePrice,
            renewal: price.renewalPrice ?? undefined,
            currency: "USD",
            provider: "vercel",
        };
    },

    async check(parsed: ParsedDomain): Promise<ProviderVerdict> {
        return (await this.checkBatch?.([parsed]))?.get(parsed.domain) ?? { provider: "vercel", status: "unknown" };
    },

    async checkBatch(domains) {
        return vercelSearch(domains.map((domain) => domain.domain));
    },
};
