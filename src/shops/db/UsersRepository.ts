import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import type { User } from "@app/shops/db/types";
import { nowUtcIso } from "@app/utils/sql-time";

export interface RegisterArgs {
    email: string;
    password: string;
    displayName: string | null;
}

export class UsersRepository {
    constructor(private readonly db: ShopsDatabase) {}

    async getById(id: number): Promise<User | undefined> {
        return this.db.kysely().selectFrom("users").selectAll().where("id", "=", id).executeTakeFirst();
    }

    async getByEmail(email: string): Promise<User | undefined> {
        return this.db
            .kysely()
            .selectFrom("users")
            .selectAll()
            .where("email", "=", email.trim().toLowerCase())
            .executeTakeFirst();
    }

    async getOrCreateLocal(): Promise<User> {
        const existing = await this.getById(1);
        if (existing) {
            return existing;
        }

        throw new Error("Default user (id=1) not seeded — migration 003 must have run");
    }

    async register(args: RegisterArgs): Promise<User> {
        const email = args.email.trim().toLowerCase();
        if (email.length === 0 || !email.includes("@")) {
            throw new Error("invalid email");
        }

        if (args.password.length < 6) {
            throw new Error("password must be at least 6 characters");
        }

        const existing = await this.getByEmail(email);
        if (existing) {
            throw new Error("email already registered");
        }

        const password_hash = await Bun.password.hash(args.password);
        const now = nowUtcIso();
        const result = await this.db
            .kysely()
            .insertInto("users")
            .values({
                email,
                password_hash,
                display_name: args.displayName,
                created_at: now,
                updated_at: now,
            })
            .executeTakeFirstOrThrow();
        const id = Number(result.insertId ?? 0);
        const user = await this.getById(id);
        if (!user) {
            throw new Error("register failed: post-insert lookup returned no row");
        }

        return user;
    }

    async verifyPassword(email: string, password: string): Promise<User | null> {
        const u = await this.getByEmail(email);
        if (!u?.password_hash) {
            return null;
        }

        const ok = await Bun.password.verify(password, u.password_hash);
        return ok ? u : null;
    }
}
