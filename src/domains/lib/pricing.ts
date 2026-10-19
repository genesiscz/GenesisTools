import { request, storage } from "@app/domains/lib/http";
import { allTlds } from "@app/domains/lib/tlds";
import type { DomainPrice } from "@app/domains/lib/types";

export interface TldPrice {
    tld: string;
    registration: number;
    renewal: number;
    transfer: number;
    /** A first-year promo is active (registration below renewal). */
    promo: boolean;
}

interface PorkbunPricing {
    status: string;
    pricing?: Record<string, { registration: string; renewal: string; transfer: string }>;
}

let tablePromise: Promise<Map<string, TldPrice>> | null = null;

/**
 * Base TLD prices from Porkbun's public pricing endpoint (no auth, every TLD it sells, USD).
 * These are list prices: a premium name costs more, which only a per-name quote reveals.
 */
export async function tldPriceTable(): Promise<Map<string, TldPrice>> {
    tablePromise ??= (async () => {
        const raw = await storage.getFileOrPut<PorkbunPricing>(
            "porkbun/pricing.json",
            async () => {
                const response = await request<PorkbunPricing>("https://api.porkbun.com/api/json/v3/pricing/get", {
                    method: "POST",
                    label: "porkbun pricing",
                    timeoutMs: 30_000,
                });
                if (response.body?.status !== "SUCCESS") {
                    throw new Error(`Porkbun pricing: HTTP ${response.status}`);
                }

                return response.body;
            },
            "1 day"
        );

        // Porkbun's table also prices names that are not delegated TLDs (Handshake and the like); keep real ones.
        const delegated = new Set(await allTlds());
        const table = new Map<string, TldPrice>();
        for (const [tld, entry] of Object.entries(raw.pricing ?? {})) {
            if (delegated.size > 500 && !delegated.has(tld.split(".").pop() ?? tld)) {
                continue;
            }

            const registration = Number.parseFloat(entry.registration);
            const renewal = Number.parseFloat(entry.renewal);
            table.set(tld, {
                tld,
                registration,
                renewal,
                transfer: Number.parseFloat(entry.transfer),
                promo: registration < renewal * 0.9,
            });
        }

        return table;
    })();
    return tablePromise;
}

export async function listPrice(tld: string): Promise<DomainPrice | null> {
    const entry = (await tldPriceTable()).get(tld);
    if (!entry) {
        return null;
    }

    return { registration: entry.registration, renewal: entry.renewal, currency: "USD", provider: "porkbun" };
}

/** Cost of holding a name for `years`: first year plus renewals. */
export function holdingCost(price: Pick<DomainPrice, "registration" | "renewal">, years: number): number {
    return price.registration + (price.renewal ?? price.registration) * Math.max(0, years - 1);
}
