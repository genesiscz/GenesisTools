import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import type { User } from "@app/shops/db/types";

export class UsersRepository {
    constructor(private readonly db: ShopsDatabase) {}

    async getById(id: number): Promise<User | undefined> {
        return this.db.kysely().selectFrom("users").selectAll().where("id", "=", id).executeTakeFirst();
    }

    async getByEmail(email: string): Promise<User | undefined> {
        return this.db.kysely().selectFrom("users").selectAll().where("email", "=", email).executeTakeFirst();
    }

    async getOrCreateLocal(): Promise<User> {
        const existing = await this.getById(1);
        if (existing) {
            return existing;
        }

        throw new Error("Default user (id=1) not seeded — migration 003 must have run");
    }
}
