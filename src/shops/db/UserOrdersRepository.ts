import logger from "@app/logger";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import type { NewUserOrder, UserOrder, UserOrderItem } from "@app/shops/db/types";
import { nowUtcIso } from "@app/utils/sql-time";

const log = logger.child({ component: "UserOrdersRepository" });

export interface UpsertOrderArgs {
    user_provider_id: number;
    external_order_id: string;
    ordered_at: string;
    total_amount: number;
    currency: string;
    items_count: number;
    state: string | null;
    raw_json: string | null;
}

export interface OrderItemInput {
    line_no: number;
    external_product_id: string | null;
    name: string;
    quantity: number | null;
    unit: string | null;
    unit_price: number | null;
    total_price: number | null;
}

export interface OrderWithItems extends UserOrder {
    items: UserOrderItem[];
}

export class UserOrdersRepository {
    constructor(private readonly db: ShopsDatabase) {}

    async upsertOrder(args: UpsertOrderArgs): Promise<number> {
        const existing = await this.db
            .kysely()
            .selectFrom("user_orders")
            .select("id")
            .where("user_provider_id", "=", args.user_provider_id)
            .where("external_order_id", "=", args.external_order_id)
            .executeTakeFirst();
        if (existing) {
            return existing.id;
        }

        const row: NewUserOrder = {
            user_provider_id: args.user_provider_id,
            external_order_id: args.external_order_id,
            ordered_at: args.ordered_at,
            total_amount: args.total_amount,
            currency: args.currency,
            items_count: args.items_count,
            state: args.state,
            raw_json: args.raw_json,
            ingested_at: nowUtcIso(),
        };
        const result = await this.db.kysely().insertInto("user_orders").values(row).executeTakeFirstOrThrow();
        const id = Number(result.insertId ?? 0);
        log.debug({ id, external: args.external_order_id }, "user_order inserted");
        return id;
    }

    async upsertOrderItems(orderId: number, items: OrderItemInput[]): Promise<void> {
        if (items.length === 0) {
            return;
        }

        const stmt = this.db
            .raw()
            .prepare(
                `INSERT OR IGNORE INTO user_order_items
                 (order_id, line_no, external_product_id, name, quantity, unit, unit_price, total_price)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            );
        for (const it of items) {
            stmt.run(
                orderId,
                it.line_no,
                it.external_product_id,
                it.name,
                it.quantity,
                it.unit,
                it.unit_price,
                it.total_price
            );
        }
    }

    async markItemMatched(
        orderId: number,
        lineNo: number,
        productId: number | null,
        masterId: number | null
    ): Promise<void> {
        await this.db
            .kysely()
            .updateTable("user_order_items")
            .set({ product_id: productId, master_product_id: masterId, matched_at: nowUtcIso() })
            .where("order_id", "=", orderId)
            .where("line_no", "=", lineNo)
            .execute();
    }

    async getOrderWithItems(orderId: number): Promise<OrderWithItems | undefined> {
        const order = await this.db
            .kysely()
            .selectFrom("user_orders")
            .selectAll()
            .where("id", "=", orderId)
            .executeTakeFirst();
        if (!order) {
            return undefined;
        }

        const items = await this.db
            .kysely()
            .selectFrom("user_order_items")
            .selectAll()
            .where("order_id", "=", orderId)
            .orderBy("line_no", "asc")
            .execute();
        return { ...order, items };
    }

    async listForUserProvider(userProviderId: number, limit = 100, offset = 0): Promise<UserOrder[]> {
        return this.db
            .kysely()
            .selectFrom("user_orders")
            .selectAll()
            .where("user_provider_id", "=", userProviderId)
            .orderBy("ordered_at", "desc")
            .limit(limit)
            .offset(offset)
            .execute();
    }

    async listExternalIds(userProviderId: number): Promise<Set<string>> {
        const rows = await this.db
            .kysely()
            .selectFrom("user_orders")
            .select("external_order_id")
            .where("user_provider_id", "=", userProviderId)
            .execute();
        return new Set(rows.map((r) => r.external_order_id));
    }
}
