import { initShopRegistry } from "@app/shops/api/registry-init";
import { ShopRegistry } from "@app/shops/api/ShopRegistry";
import { renderShopsTable } from "@app/shops/lib/render";
import type { Command } from "commander";

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
