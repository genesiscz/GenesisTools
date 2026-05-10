import type { ListedProduct, ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { ShopsDatabase as ShopsDatabaseClass } from "@app/shops/db/ShopsDatabase";
import { formatTable } from "@app/utils/table";
import type { Command } from "commander";

export interface RunListInput {
    shop: string;
    category?: string;
    limit: number;
    offset?: number;
    search?: string;
    db: ShopsDatabase;
}

export async function runListCommand(input: RunListInput): Promise<ListedProduct[]> {
    return input.db.listProducts({
        shopOrigin: input.shop,
        categoryId: input.category,
        limit: input.limit,
        offset: input.offset ?? 0,
        search: input.search,
    });
}

export function registerListCommand(program: Command): void {
    program
        .command("list <shop>")
        .description("List products from local DB for one shop")
        .option("--cat <id>", "Restrict to one category id")
        .option("--limit <n>", "Max rows to return", (v) => Number.parseInt(v, 10), 50)
        .option("--search <query>", "Full-text search (diacritic-insensitive prefix)")
        .action(async (shop: string, raw: { cat?: string; limit: number; search?: string }) => {
            const db = new ShopsDatabaseClass();
            try {
                const rows = await runListCommand({
                    shop,
                    category: raw.cat,
                    limit: raw.limit,
                    search: raw.search,
                    db,
                });
                if (rows.length === 0) {
                    process.stdout.write("No products found.\n");
                    return;
                }

                const tableRows = rows.map((r) => [
                    String(r.id),
                    r.name.length > 60 ? `${r.name.slice(0, 57)}...` : r.name,
                    r.brand ?? "",
                    r.currentPrice !== undefined ? `${r.currentPrice} CZK` : "—",
                ]);
                const table = formatTable(tableRows, ["id", "name", "brand", "price"]);
                process.stdout.write(`${table}\n`);
            } finally {
                db.close();
            }
        });
}
