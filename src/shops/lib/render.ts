import type { ShopRegistry } from "@app/shops/api/ShopRegistry";
import { formatTable } from "@app/utils/table";

function boolMark(b: boolean): string {
    return b ? "yes" : "no";
}

export function renderShopsTable(registry: ShopRegistry): string {
    const headers = ["shop", "live", "history", "listing", "ean", "search", "bot-protection"];
    const rows = registry
        .all()
        .map((c) => [
            c.shopOrigin,
            boolMark(c.capabilities.live),
            boolMark(c.capabilities.history),
            boolMark(c.capabilities.listing),
            boolMark(c.capabilities.ean),
            boolMark(c.capabilities.search),
            c.capabilities.botProtection,
        ]);

    const table = formatTable(rows, headers);
    if (rows.length === 0) {
        return `${table}\n\n0 shops registered. Per-shop clients land in Plan 03.`;
    }

    return table;
}
