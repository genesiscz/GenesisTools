import { formatTable } from "@app/utils/table";
import type { Command } from "commander";
import { initShopRegistry } from "../api/registry-init";
import { ShopRegistry } from "../api/ShopRegistry";

export function registerShopsCommand(program: Command): void {
    program
        .command("shops")
        .description("List supported shops + capability matrix")
        .action(async () => {
            initShopRegistry();
            const r = ShopRegistry.get();
            process.stdout.write(`${renderShopsTable(r)}\n`);
        });
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

function boolMark(b: boolean): string {
    return b ? "yes" : "no";
}
