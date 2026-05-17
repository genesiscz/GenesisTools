import logger from "@app/logger";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import type { Session } from "@app/shops/db/types";
import { randomToken } from "@app/shops/lib/auth";
import { nowUtcIso } from "@app/utils/sql-time";

const log = logger.child({ component: "SessionsRepository" });

export interface CreateSessionArgs {
    userId: number;
    ttlDays: number;
}

export class SessionsRepository {
    constructor(private readonly db: ShopsDatabase) {}

    async create(args: CreateSessionArgs): Promise<Session> {
        const token = randomToken();
        const now = nowUtcIso();
        const expires = new Date(Date.now() + args.ttlDays * 86_400_000).toISOString();
        await this.db
            .kysely()
            .insertInto("sessions")
            .values({
                token,
                user_id: args.userId,
                created_at: now,
                expires_at: expires,
                last_seen_at: now,
            })
            .execute();
        log.info({ userId: args.userId }, "session created");
        return {
            token,
            user_id: args.userId,
            created_at: now,
            expires_at: expires,
            last_seen_at: now,
        };
    }

    async findByToken(token: string): Promise<Session | undefined> {
        return this.db.kysely().selectFrom("sessions").selectAll().where("token", "=", token).executeTakeFirst();
    }

    async delete(token: string): Promise<void> {
        await this.db.kysely().deleteFrom("sessions").where("token", "=", token).execute();
    }

    async deleteExpired(): Promise<number> {
        const result = await this.db
            .kysely()
            .deleteFrom("sessions")
            .where("expires_at", "<=", nowUtcIso())
            .executeTakeFirst();
        return Number(result.numDeletedRows ?? 0);
    }
}
