import logger from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { nowUtcIso } from "@app/utils/sql-time";
import type { Selectable } from "kysely";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import type { NotificationsTable } from "@app/shops/db/types";

const log = logger.child({ component: "NotificationsRepository" });

export type NotificationReason = "target-price" | "drop-percent" | "drop-absolute" | "back-in-stock";
export type DeliveryChannel = "macos" | "web" | "telegram";

export interface RecordNotificationArgs {
    favorite_id: number;
    master_product_id: number;
    product_id: number | null;
    reason: NotificationReason;
    prev_price: number | null;
    curr_price: number | null;
    shop_origin: string | null;
    metadata: Record<string, unknown>;
}

export type Notification = Selectable<NotificationsTable>;

const CHANNEL_COLUMN: Record<DeliveryChannel, "delivered_macos_at" | "delivered_web_at" | "delivered_telegram_at"> = {
    macos: "delivered_macos_at",
    web: "delivered_web_at",
    telegram: "delivered_telegram_at",
};

export interface ListNotificationsArgs {
    limit?: number;
    reason?: NotificationReason;
    shop_origin?: string;
}

export class NotificationsRepository {
    constructor(private readonly db: ShopsDatabase) {}

    async record(args: RecordNotificationArgs): Promise<number> {
        const ts = nowUtcIso();
        const result = await this.db
            .kysely()
            .insertInto("notifications")
            .values({
                favorite_id: args.favorite_id,
                master_product_id: args.master_product_id,
                product_id: args.product_id,
                fired_at: ts,
                reason: args.reason,
                prev_price: args.prev_price,
                curr_price: args.curr_price,
                shop_origin: args.shop_origin,
                metadata_json: SafeJSON.stringify(args.metadata ?? {}),
            })
            .executeTakeFirstOrThrow();
        const id = Number(result.insertId ?? 0);
        log.debug({ notificationId: id, reason: args.reason, favorite_id: args.favorite_id }, "notification recorded");
        return id;
    }

    async findRecentByFavoriteAndReason(
        favoriteId: number,
        reason: NotificationReason,
        cooldownHours: number
    ): Promise<Notification | undefined> {
        const cutoffMs = Date.now() - cooldownHours * 3_600_000;
        const cutoffIso = new Date(cutoffMs).toISOString();
        return this.db
            .kysely()
            .selectFrom("notifications")
            .selectAll()
            .where("favorite_id", "=", favoriteId)
            .where("reason", "=", reason)
            .where("fired_at", ">=", cutoffIso)
            .orderBy("fired_at", "desc")
            .limit(1)
            .executeTakeFirst();
    }

    async markDelivered(id: number, channel: DeliveryChannel): Promise<void> {
        const col = CHANNEL_COLUMN[channel];
        await this.db
            .kysely()
            .updateTable("notifications")
            .set({ [col]: nowUtcIso() })
            .where("id", "=", id)
            .execute();
    }

    async setDeliveryError(id: number, message: string): Promise<void> {
        await this.db
            .kysely()
            .updateTable("notifications")
            .set({ delivery_error: message })
            .where("id", "=", id)
            .execute();
    }

    async listUnacked(): Promise<Notification[]> {
        return this.db
            .kysely()
            .selectFrom("notifications")
            .selectAll()
            .where("acknowledged_at", "is", null)
            .orderBy("fired_at", "desc")
            .execute();
    }

    async listAll(args: ListNotificationsArgs = {}): Promise<Notification[]> {
        let q = this.db.kysely().selectFrom("notifications").selectAll().orderBy("fired_at", "desc");
        if (args.reason) {
            q = q.where("reason", "=", args.reason);
        }

        if (args.shop_origin) {
            q = q.where("shop_origin", "=", args.shop_origin);
        }

        if (args.limit) {
            q = q.limit(args.limit);
        }

        return q.execute();
    }

    async ack(id: number): Promise<void> {
        await this.db
            .kysely()
            .updateTable("notifications")
            .set({ acknowledged_at: nowUtcIso() })
            .where("id", "=", id)
            .execute();
    }

    async ackAll(): Promise<void> {
        await this.db
            .kysely()
            .updateTable("notifications")
            .set({ acknowledged_at: nowUtcIso() })
            .where("acknowledged_at", "is", null)
            .execute();
    }
}
