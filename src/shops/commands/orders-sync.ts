import { logger } from "@app/logger";
import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { UserProvidersRepository } from "@app/shops/db/UserProvidersRepository";
import { syncProvider } from "@app/shops/lib/order-sync";
import { realAuthClientFactory } from "@app/shops/lib/order-sync-clients";
import type { Command } from "commander";

const log = logger.child({ component: "shops:orders-sync" });

interface CliOpts {
    shop?: string;
    limit?: number;
    user?: number;
}

export function registerOrdersSyncCommand(program: Command): void {
    program
        .command("orders-sync")
        .description("Pull past orders from connected providers and resolve items into the local match graph")
        .option("--shop <origin>", "Limit to one shop (e.g. rohlik.cz)")
        .option("--limit <n>", "Cap orders fetched per provider", (v) => Number.parseInt(v, 10))
        .option("--user <id>", "User id (default 1)", (v) => Number.parseInt(v, 10))
        .action(async (raw: CliOpts) => {
            const userId = raw.user ?? 1;
            const db = new ShopsDatabase();
            const repo = new UserProvidersRepository(db);
            try {
                const all = await repo.listForUser(userId);
                const targets = all.filter(
                    (p) => p.status === "connected" && (!raw.shop || p.shop_origin === raw.shop)
                );
                if (targets.length === 0) {
                    process.stdout.write("No connected providers to sync\n");
                    return;
                }

                for (const provider of targets) {
                    process.stdout.write(`→ syncing ${provider.shop_origin} (provider_id=${provider.id})\n`);
                    try {
                        const result = await syncProvider({
                            userProviderId: provider.id,
                            factory: realAuthClientFactory,
                            limit: raw.limit ?? 20,
                        });
                        process.stdout.write(
                            `  ✓ orders=${result.orders_new} items=${result.items_new} matched=${result.items_matched} auto-added=${result.auto_added}\n`
                        );
                    } catch (err) {
                        process.stdout.write(`  × ${err instanceof Error ? err.message : String(err)}\n`);
                    }
                }
            } catch (err) {
                log.error({ err: err instanceof Error ? err.message : String(err) }, "orders-sync failed");
                process.stderr.write(`× ${err instanceof Error ? err.message : String(err)}\n`);
                process.exitCode = 1;
            } finally {
                db.close();
            }
        });
}
