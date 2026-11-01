import { HlidacShopuClient } from "@app/shops/api/HlidacShopuClient";
import { logger } from "@genesiscz/utils/logger";
import type { AlzaApi } from "./api";
import { getProduct } from "./catalog";

export interface PricePoint {
    date: string;
    price: number | null;
    originalPrice: number | null;
}

export interface PriceHistory {
    productId: number;
    name: string;
    url: string;
    source: "s3" | "api" | "scrape" | "none";
    points: PricePoint[];
    currentPrice?: number;
    lowest?: { price: number; date: string };
    highest?: { price: number; date: string };
    /** Lowest price in the 30 days before the latest point. */
    lowest30Days?: number;
    /** Hlídač shopů's "real discount" against its own reference price, in percent. */
    realDiscount?: number;
    /** The discount the shop claims, in percent. */
    claimedDiscount?: number;
}

const DAY_MS = 86_400_000;

/** Hlídač shopů sends discounts as fractions (0.111 = 11.1 %). */
function asPercent(fraction: unknown): number | undefined {
    return typeof fraction === "number" ? Math.round(fraction * 1000) / 10 : undefined;
}

/** Price history from Hlídač shopů (hlidacshopu.cz), which tracks Alza daily. */
export async function getPriceHistory(api: AlzaApi, ref: string): Promise<PriceHistory> {
    const product = await getProduct(api, ref);
    const url = product.url.replace(/\?.*$/, "");
    const hlidac = new HlidacShopuClient();
    const [byUrl, detail] = await Promise.all([
        hlidac.getByUrl(url),
        hlidac.detail(url).catch((error: unknown) => {
            logger.debug({ error, url }, "hlidac detail unavailable");
            return undefined;
        }),
    ]);

    let points: PricePoint[] = [];
    if (byUrl.history) {
        points = byUrl.history.entries.map((e) => ({ date: e.d, price: e.c, originalPrice: e.o }));
    } else if (byUrl.detail ?? detail) {
        const data = (byUrl.detail ?? detail)?.data;
        const originals = new Map((data?.originalPrice ?? []).map((p) => [p.x, p.y]));
        points = (data?.currentPrice ?? []).map((p) => ({
            date: p.x,
            price: p.y,
            originalPrice: originals.get(p.x) ?? null,
        }));
    }

    points.sort((a, b) => a.date.localeCompare(b.date));
    const priced = points.filter((p): p is PricePoint & { price: number } => typeof p.price === "number");
    const last = priced.at(-1);
    const lowest = priced.reduce<(typeof priced)[number] | undefined>(
        (min, p) => (!min || p.price < min.price ? p : min),
        undefined
    );
    const highest = priced.reduce<(typeof priced)[number] | undefined>(
        (max, p) => (!max || p.price > max.price ? p : max),
        undefined
    );
    const cutoff = last ? new Date(last.date).getTime() - 30 * DAY_MS : 0;
    const window = priced.filter((p) => new Date(p.date).getTime() >= cutoff && p !== last);
    const metadata = (byUrl.detail ?? detail)?.metadata;

    logger.debug({ url, source: byUrl.source, points: points.length }, "alza price history");
    return {
        productId: product.id,
        name: product.name,
        url,
        source: points.length ? byUrl.source : "none",
        points,
        currentPrice: product.price,
        lowest: lowest ? { price: lowest.price, date: lowest.date } : undefined,
        highest: highest ? { price: highest.price, date: highest.date } : undefined,
        lowest30Days: window.length ? Math.min(...window.map((p) => p.price)) : undefined,
        realDiscount: asPercent(metadata?.realDiscount),
        claimedDiscount: asPercent(metadata?.claimedDiscount),
    };
}
