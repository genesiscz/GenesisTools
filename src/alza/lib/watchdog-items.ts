import type { WatchItemLine } from "@genesiscz/utils/watch/items";
import type { Watchdog } from "./account";

/** Alza's availability text when the product can ship now ("Skladem", "Skladem > 5 ks", "In stock"). */
function inStock(availability: string | undefined): boolean {
    return /^\s*(skladem|in stock|na skladě)/i.test(availability ?? "");
}

/**
 * The watchdogs whose condition holds now, as Monitor item lines (`tools alza watchdog list --items`, mobile plan
 * M12). The guid carries the state that fired (`<product>:price:<price>`, `<product>:stock`), so Monitor reports a
 * price that dropped further, or stock that came back after a gap, as a new item, and the same state only once.
 */
export function watchdogItems(watchdogs: readonly Watchdog[]): WatchItemLine[] {
    return watchdogs.flatMap((watchdog) => {
        const id = String(watchdog.productId ?? watchdog.id ?? watchdog.name ?? "");
        const name = watchdog.name ?? id;
        const link = watchdog.url ?? null;
        const items: WatchItemLine[] = [];

        if (!id) {
            return items;
        }

        if (
            watchdog.maxPrice !== undefined &&
            watchdog.currentPrice !== undefined &&
            watchdog.currentPrice <= watchdog.maxPrice
        ) {
            items.push({
                guid: `${id}:price:${watchdog.currentPrice}`,
                title: `${name} costs ${watchdog.currentPrice} (watching below ${watchdog.maxPrice})`,
                link,
                summary: watchdog.availability ?? null,
            });
        }

        if (watchdog.trackingStock && inStock(watchdog.availability)) {
            items.push({
                guid: `${id}:stock`,
                title: `${name} is in stock`,
                link,
                summary: watchdog.availability ?? null,
            });
        }

        return items;
    });
}

/** The watchdog list an operation answered, or an empty list for any other shape. */
export function watchdogsOf(data: unknown): Watchdog[] {
    const items = typeof data === "object" && data !== null ? (data as { items?: unknown }).items : undefined;
    return Array.isArray(items)
        ? items.filter((item): item is Watchdog => typeof item === "object" && item !== null)
        : [];
}
