import { SafeJSON } from "@app/utils/json";
import { formatTable } from "@app/utils/table";
import type { Command } from "commander";
import type { NotificationReason } from "../db/NotificationsRepository";
import {
    ackAllNotifications,
    ackNotification,
    getRecentNotifications,
    type RecentNotificationsArgs,
} from "../lib/watchlist-api";

const VALID_REASONS = new Set<NotificationReason>([
    "target-price",
    "drop-percent",
    "drop-absolute",
    "back-in-stock",
]);

export function registerNotifyCommand(program: Command): void {
    const notify = program.command("notify").description("Inspect and acknowledge notifications");

    notify
        .command("list")
        .description("Show pending notifications (default) or all")
        .option("--all", "Include acknowledged notifications")
        .option("--reason <reason>", "Filter by reason")
        .option("--shop <origin>", "Filter by shop_origin")
        .option("--limit <n>", "Max rows", "100")
        .option("--json", "Output JSON")
        .action(
            async (opts: { all?: boolean; reason?: string; shop?: string; limit?: string; json?: boolean }) => {
                if (opts.reason && !VALID_REASONS.has(opts.reason as NotificationReason)) {
                    throw new Error(
                        `Invalid --reason "${opts.reason}". Use one of: target-price, drop-percent, drop-absolute, back-in-stock.`
                    );
                }

                const args: RecentNotificationsArgs = {
                    onlyUnacked: !opts.all,
                    reason: opts.reason as NotificationReason | undefined,
                    shop_origin: opts.shop,
                    limit: opts.limit ? Number(opts.limit) : 100,
                };
                const rows = await getRecentNotifications(args);
                if (opts.json) {
                    console.log(SafeJSON.stringify(rows, null, 2));
                    return;
                }

                console.log(
                    formatTable(
                        rows.map((r) => [
                            String(r.id),
                            r.fired_at,
                            r.reason,
                            r.shop_origin ?? "—",
                            r.curr_price !== null ? r.curr_price.toFixed(2) : "—",
                            r.acknowledged_at ? "ack" : "PENDING",
                        ]),
                        ["id", "fired_at", "reason", "shop", "price", "status"]
                    )
                );
            }
        );

    notify
        .command("ack")
        .argument("[id]", "Notification id (omit with --all)")
        .description("Acknowledge a notification (or --all to ack everything pending)")
        .option("--all", "Acknowledge all pending notifications")
        .action(async (idArg: string | undefined, opts: { all?: boolean }) => {
            if (opts.all) {
                await ackAllNotifications();
                console.log("acknowledged all pending");
                return;
            }

            if (!idArg) {
                throw new Error("Provide an id or use --all.");
            }

            await ackNotification(Number(idArg));
            console.log(`acknowledged #${idArg}`);
        });
}
