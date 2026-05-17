import logger from "@app/logger";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import type { UserProvider } from "@app/shops/db/types";
import { decryptCredentials, encryptCredentials } from "@app/shops/lib/crypto";
import { SafeJSON } from "@app/utils/json";
import { nowUtcIso } from "@app/utils/sql-time";

const log = logger.child({ component: "UserProvidersRepository" });

export type ProviderCredentials =
    | { type: "email-password"; email: string; password: string }
    | { type: "session-cookie"; cookie: string };

export interface ConnectArgs {
    user_id: number;
    shop_origin: string;
    credentials: ProviderCredentials;
    external_user_email: string | null;
}

export interface UserProviderWithShop extends UserProvider {
    display_name: string;
}

export interface UpdateAutoWatchlistArgs {
    auto_watchlist: boolean;
    watchlist_defaults?: Record<string, unknown>;
}

export class UserProvidersRepository {
    constructor(private readonly db: ShopsDatabase) {}

    async connect(args: ConnectArgs): Promise<number> {
        const blob = encryptCredentials(SafeJSON.stringify(args.credentials));
        const now = nowUtcIso();
        const existing = await this.getByShop(args.user_id, args.shop_origin);
        if (existing) {
            await this.db
                .kysely()
                .updateTable("user_providers")
                .set({
                    credentials_blob: blob,
                    external_user_email: args.external_user_email,
                    status: "connected",
                    last_sync_error: null,
                    updated_at: now,
                })
                .where("id", "=", existing.id)
                .execute();
            log.info({ id: existing.id, shop: args.shop_origin }, "provider re-connected");
            return existing.id;
        }

        const result = await this.db
            .kysely()
            .insertInto("user_providers")
            .values({
                user_id: args.user_id,
                shop_origin: args.shop_origin,
                status: "connected",
                credentials_blob: blob,
                external_user_email: args.external_user_email,
                created_at: now,
                updated_at: now,
            })
            .executeTakeFirstOrThrow();
        const id = Number(result.insertId ?? 0);
        log.info({ id, shop: args.shop_origin }, "provider connected");
        return id;
    }

    async disconnect(id: number): Promise<void> {
        await this.db
            .kysely()
            .updateTable("user_providers")
            .set({ status: "disconnected", credentials_blob: null, updated_at: nowUtcIso() })
            .where("id", "=", id)
            .execute();
    }

    async listForUser(userId: number): Promise<UserProviderWithShop[]> {
        const rows = await this.db
            .kysely()
            .selectFrom("user_providers")
            .innerJoin("shops", "shops.origin", "user_providers.shop_origin")
            .where("user_providers.user_id", "=", userId)
            .selectAll("user_providers")
            .select("shops.display_name as display_name")
            .execute();
        return rows as unknown as UserProviderWithShop[];
    }

    async getByShop(userId: number, shopOrigin: string): Promise<UserProvider | undefined> {
        return this.db
            .kysely()
            .selectFrom("user_providers")
            .selectAll()
            .where("user_id", "=", userId)
            .where("shop_origin", "=", shopOrigin)
            .executeTakeFirst();
    }

    async getById(id: number): Promise<UserProvider | undefined> {
        return this.db.kysely().selectFrom("user_providers").selectAll().where("id", "=", id).executeTakeFirst();
    }

    async getCredentials(id: number): Promise<ProviderCredentials> {
        const row = await this.getById(id);
        if (!row?.credentials_blob) {
            throw new Error(`No credentials stored for user_provider ${id}`);
        }

        return SafeJSON.parse(decryptCredentials(row.credentials_blob)) as ProviderCredentials;
    }

    async setStatus(id: number, status: UserProvider["status"], error: string | null = null): Promise<void> {
        await this.db
            .kysely()
            .updateTable("user_providers")
            .set({ status, last_sync_error: error, updated_at: nowUtcIso() })
            .where("id", "=", id)
            .execute();
    }

    async setLastSync(id: number, at: string): Promise<void> {
        await this.db
            .kysely()
            .updateTable("user_providers")
            .set({ last_sync_at: at, last_sync_error: null, updated_at: nowUtcIso() })
            .where("id", "=", id)
            .execute();
    }

    async updateAutoWatchlist(id: number, args: UpdateAutoWatchlistArgs): Promise<void> {
        const update: Record<string, unknown> = {
            auto_watchlist: args.auto_watchlist ? 1 : 0,
            updated_at: nowUtcIso(),
        };
        if (args.watchlist_defaults !== undefined) {
            update.watchlist_defaults_json = SafeJSON.stringify(args.watchlist_defaults);
        }

        await this.db
            .kysely()
            .updateTable("user_providers")
            .set(update as never)
            .where("id", "=", id)
            .execute();
    }
}
