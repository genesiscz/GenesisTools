import { logger, out } from "@app/logger";
import { parseCooldown, parsePercent } from "@app/shops/lib/watch-parsing";
import { addFavorite, editFavorite, getWatchlist, removeFavorite } from "@app/shops/lib/watchlist-api";
import { runWatchlistTick } from "@app/shops/lib/watchlist-tick";
import { SafeJSON } from "@app/utils/json";
import { formatTable } from "@app/utils/table";
import type { Command } from "commander";

const log = logger.child({ component: "shops:watch-cmd" });

// CLI runs as the seeded local user (migration 003 inserts user id=1).
const LOCAL_USER_ID = 1;

export function registerWatchCommand(program: Command): void {
    const watch = program.command("watch").description("Manage the watchlist (favorites with discount alerts)");

    watch
        .command("add <url>", { isDefault: true })
        .description("Add a product URL to the watchlist")
        .option("--target <n>", "Target price (CZK) — alert when current ≤ this")
        .option("--drop <pct>", "Drop percent — alert when (ref - cur) / ref ≥ this. '15' or '15%' = 0.15.")
        .option("--drop-abs <n>", "Drop absolute (CZK)")
        .option("--shop <origin>", "Restrict to one shop (e.g. 'rohlik.cz')")
        .option("--label <text>", "User-visible note")
        .option("--cooldown <duration>", "Cooldown between same-reason alerts ('24h', '2d', or hours number)", "24")
        .option("--notify-back-in-stock", "Also notify when back in stock", false)
        .action(async (url: string, opts: Record<string, string | boolean | undefined>) => {
            const targetPrice = opts.target !== undefined ? Number(opts.target) : null;
            const dropPercent = opts.drop !== undefined ? parsePercent(String(opts.drop)) : null;
            const dropAbsolute = opts.dropAbs !== undefined ? Number(opts.dropAbs) : null;
            const cooldownHours = parseCooldown(String(opts.cooldown ?? "24"));
            const result = await addFavorite(LOCAL_USER_ID, {
                url,
                target_price: targetPrice,
                drop_percent: dropPercent,
                drop_absolute: dropAbsolute,
                restricted_to_shop: typeof opts.shop === "string" ? opts.shop : null,
                label: typeof opts.label === "string" ? opts.label : null,
                cooldown_hours: cooldownHours,
                notify_back_in_stock: opts.notifyBackInStock === true,
            });
            const table = formatTable(
                [[String(result.favorite_id), String(result.master_product_id), result.auto_ingested ? "yes" : "no"]],
                ["favorite_id", "master_product_id", "auto-ingested"]
            );
            out.println(table);
            out.println(
                `Will notify on: ${[
                    targetPrice !== null ? `target ≤ ${targetPrice} CZK` : null,
                    dropPercent !== null ? `${(dropPercent * 100).toFixed(1)}% drop` : null,
                    dropAbsolute !== null ? `${dropAbsolute} CZK drop` : null,
                ]
                    .filter(Boolean)
                    .join(" OR ")}`
            );
        });

    watch
        .command("list")
        .description("List active favorites with their current state")
        .option("--json", "Output JSON")
        .action(async (opts: { json?: boolean }) => {
            const rows = await getWatchlist(LOCAL_USER_ID);
            if (opts.json) {
                out.println(SafeJSON.stringify(rows, null, 2));
                return;
            }

            out.println(
                formatTable(
                    rows.map((r) => [
                        String(r.id),
                        r.label ?? "(no label)",
                        r.restricted_to_shop ?? "any",
                        r.target_price !== null ? r.target_price.toFixed(2) : "—",
                        r.best_price !== null ? r.best_price.toFixed(2) : "—",
                        r.delta_percent !== null ? `${(r.delta_percent * 100).toFixed(1)}%` : "—",
                        r.best_shop ?? "—",
                    ]),
                    ["id", "label", "scope", "target", "current", "Δ", "shop"]
                )
            );
        });

    watch
        .command("remove <id>")
        .description("Remove a favorite by id")
        .action(async (idStr: string) => {
            const id = Number(idStr);
            await removeFavorite(LOCAL_USER_ID, id);
            out.println(`removed favorite #${id}`);
        });

    watch
        .command("edit <id>")
        .description("Edit thresholds on an existing favorite")
        .option("--target <n>", "Target price (CZK)")
        .option("--drop <pct>", "Drop percent")
        .option("--drop-abs <n>", "Drop absolute")
        .option("--label <text>", "Label")
        .option("--cooldown <duration>", "Cooldown")
        .option("--active <on|off>", "Activate/deactivate")
        .action(async (idStr: string, opts: Record<string, string | undefined>) => {
            const id = Number(idStr);
            const patch: Record<string, unknown> = {};
            if (opts.target !== undefined) {
                patch.target_price = Number(opts.target);
            }

            if (opts.drop !== undefined) {
                patch.drop_percent = parsePercent(opts.drop);
            }

            if (opts.dropAbs !== undefined) {
                patch.drop_absolute = Number(opts.dropAbs);
            }

            if (opts.label !== undefined) {
                patch.label = opts.label;
            }

            if (opts.cooldown !== undefined) {
                patch.cooldown_hours = parseCooldown(opts.cooldown);
            }

            if (opts.active !== undefined) {
                patch.active = opts.active === "on";
            }

            const updated = await editFavorite(LOCAL_USER_ID, id, patch);
            out.println(SafeJSON.stringify(updated, null, 2));
        });

    watch
        .command("tick")
        .description("Internal: run a single watchlist evaluation pass (used by daemon)")
        .option("--json", "Output the TickReport as JSON", true)
        .action(async () => {
            const report = await runWatchlistTick();
            out.println(SafeJSON.stringify(report));
            log.info(report, "tick complete");
        });
}
