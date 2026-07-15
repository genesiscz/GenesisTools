import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { loginUser, registerUser } from "@app/youtube/lib/users";
import { STARTING_CREDITS } from "@app/youtube/lib/users.types";

let db: YoutubeDatabase;

beforeEach(() => {
    db = new YoutubeDatabase(":memory:");
});

afterEach(() => {
    db.close();
});

describe("registerUser", () => {
    it("registers with the starting grant and a ytu_ token", async () => {
        const { user, token } = await registerUser(db, { email: "New@Example.com ", password: "password123" });

        expect(user.email).toBe("new@example.com");
        expect(user.credits).toBe(STARTING_CREDITS);
        expect(token).toMatch(/^ytu_[0-9a-f]{64}$/);
        expect(db.getUserByToken(token)?.id).toBe(user.id);
    });

    it("writes the register grant through the ledger", async () => {
        const { user } = await registerUser(db, { email: "a@b.co", password: "password123" });
        const ledger = db
            .getDb()
            .query("SELECT delta, reason FROM credit_ledger WHERE user_id = ?")
            .all(user.id) as Array<{ delta: number; reason: string }>;

        expect(ledger).toEqual([{ delta: STARTING_CREDITS, reason: "register-grant" }]);
    });

    it("rejects invalid emails and short passwords", async () => {
        await expect(registerUser(db, { email: "not-an-email", password: "password123" })).rejects.toThrow(
            "valid email"
        );
        await expect(registerUser(db, { email: "a@b.co", password: "short" })).rejects.toThrow("at least 8");
    });

    it("rejects duplicate emails case-insensitively", async () => {
        await registerUser(db, { email: "a@b.co", password: "password123" });
        await expect(registerUser(db, { email: "A@B.CO", password: "password456" })).rejects.toThrow(
            "already exists"
        );
    });
});

describe("loginUser", () => {
    it("returns the same stable token as register", async () => {
        const registered = await registerUser(db, { email: "a@b.co", password: "password123" });
        const logged = await loginUser(db, { email: "a@b.co", password: "password123" });

        expect(logged.token).toBe(registered.token);
        expect(logged.user.id).toBe(registered.user.id);
        expect(logged.user).not.toHaveProperty("passwordHash");
        expect(logged.user).not.toHaveProperty("apiToken");
    });

    it("stamps last_login_at", async () => {
        const { user } = await registerUser(db, { email: "a@b.co", password: "password123" });
        await loginUser(db, { email: "a@b.co", password: "password123" });
        const row = db.getDb().query("SELECT last_login_at FROM users WHERE id = ?").get(user.id) as {
            last_login_at: string | null;
        };

        expect(row.last_login_at).toMatch(/Z$/);
    });

    it("uses the same message for unknown email and wrong password", async () => {
        await registerUser(db, { email: "a@b.co", password: "password123" });

        await expect(loginUser(db, { email: "nobody@b.co", password: "password123" })).rejects.toThrow(
            "Invalid email or password"
        );
        await expect(loginUser(db, { email: "a@b.co", password: "wrong-password" })).rejects.toThrow(
            "Invalid email or password"
        );
    });
});
