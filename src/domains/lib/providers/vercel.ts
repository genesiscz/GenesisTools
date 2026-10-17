import { homedir } from "node:os";
import { join } from "node:path";
import { request, storage } from "@app/domains/lib/http";
import type { DomainProvider } from "@app/domains/lib/providers/types";
import type { DomainPrice, ParsedDomain, ProviderVerdict } from "@app/domains/lib/types";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";

const API = "https://api.vercel.com/v1/registrar";

interface VercelPrice {
    years: number;
    purchasePrice: number | null;
    renewalPrice: number | null;
    transferPrice: number | null;
}

/** Where the Vercel CLI keeps its login token on each platform. */
function vercelCliAuthPaths(): string[] {
    const home = homedir();
    const xdg = env.getTrimmed("XDG_DATA_HOME") ?? join(home, ".local", "share");
    const appData = env.getTrimmed("APPDATA");
    return [
        join(home, "Library", "Application Support", "com.vercel.cli", "auth.json"),
        join(xdg, "com.vercel.cli", "auth.json"),
        ...(appData ? [join(appData, "com.vercel.cli", "Data", "auth.json")] : []),
    ];
}

async function resolveToken(): Promise<{ token: string; source: string } | null> {
    const fromEnv = env.domains.getVercelToken();
    if (fromEnv) {
        return { token: fromEnv, source: "VERCEL_TOKEN" };
    }

    for (const path of vercelCliAuthPaths()) {
        const file = Bun.file(path);
        if (!(await file.exists())) {
            continue;
        }

        try {
            const auth: unknown = await file.json();
            if (auth && typeof auth === "object" && "token" in auth && typeof auth.token === "string") {
                return { token: auth.token, source: "Vercel CLI login" };
            }
        } catch (error) {
            logger.debug({ path, error }, "domains: unreadable Vercel CLI auth file");
        }
    }

    return null;
}

let tokenPromise: ReturnType<typeof resolveToken> | null = null;

async function token(): Promise<string> {
    tokenPromise ??= resolveToken();
    const resolved = await tokenPromise;
    if (!resolved) {
        throw new Error("Vercel: no token. Set VERCEL_TOKEN or run `vercel login`.");
    }

    return resolved.token;
}

async function vercelGet<T>(path: string): Promise<{ status: number; body: T | null; text: string }> {
    return request<T>(`${API}${path}`, { label: "vercel", headers: { Authorization: `Bearer ${await token()}` } });
}

function toPrice(price: VercelPrice, premium?: boolean): DomainPrice | undefined {
    if (price.purchasePrice === null) {
        return undefined;
    }

    return {
        registration: price.purchasePrice,
        renewal: price.renewalPrice ?? undefined,
        currency: "USD",
        provider: "vercel",
        ...(premium !== undefined ? { premium } : {}),
    };
}

async function supportedTlds(): Promise<Set<string>> {
    const list = await storage.getFileOrPut<string[]>(
        "vercel/tlds.json",
        async () => {
            const response = await vercelGet<string[]>("/tlds/supported");
            if (!Array.isArray(response.body)) {
                throw new Error(`Vercel TLD list failed: HTTP ${response.status}`);
            }

            return response.body;
        },
        "7 days"
    );
    return new Set(list);
}

export const vercelProvider: DomainProvider = {
    id: "vercel",
    label: "Vercel Registrar",
    capabilities: { availability: true, price: true, registration: false },

    async status() {
        const resolved = await resolveToken();
        return resolved
            ? { configured: true, detail: resolved.source }
            : { configured: false, detail: "set VERCEL_TOKEN or run `vercel login`" };
    },

    async supports(tld) {
        if (!(await resolveToken())) {
            return false;
        }

        return (await supportedTlds()).has(tld);
    },

    async tldPrice(tld) {
        const price = await storage.getFileOrPut<VercelPrice | null>(
            `vercel/tld-price-${tld}.json`,
            async () => (await vercelGet<VercelPrice>(`/tlds/${tld}/price`)).body,
            "1 day"
        );
        return price ? (toPrice(price, false) ?? null) : null;
    },

    async check(parsed: ParsedDomain): Promise<ProviderVerdict> {
        const availability = await vercelGet<{ available: boolean }>(`/domains/${parsed.domain}/availability`);
        if (!availability.body || typeof availability.body.available !== "boolean") {
            return { provider: "vercel", status: "unknown", detail: `HTTP ${availability.status}` };
        }

        if (!availability.body.available) {
            return { provider: "vercel", status: "taken" };
        }

        const [quote, base] = await Promise.all([
            vercelGet<VercelPrice>(`/domains/${parsed.domain}/price`),
            this.tldPrice?.(parsed.tld) ?? Promise.resolve(null),
        ]);
        if (!quote.body) {
            return { provider: "vercel", status: "available", detail: `price HTTP ${quote.status}` };
        }

        const registration = quote.body.purchasePrice ?? 0;
        const premium = base !== null && registration > base.registration * 1.05;
        return {
            provider: "vercel",
            status: premium ? "premium" : "available",
            price: toPrice(quote.body, premium),
            ...(premium && base ? { detail: `standard ${base.currency} ${base.registration}` } : {}),
        };
    },
};
