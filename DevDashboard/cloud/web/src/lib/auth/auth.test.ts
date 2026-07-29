import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Force an in-memory SQLite DB + a fixed secret BEFORE importing anything that reads env.
process.env.DD_CLOUD_DATABASE_URL = ":memory:";
process.env.DD_CLOUD_DATABASE_DRIVER = "sqlite";
process.env.DD_CLOUD_AUTH_SECRET = "test-secret-not-for-prod";
process.env.DD_CLOUD_APP_URL = "http://localhost:7251";

describe("better-auth + drizzle (sqlite, in-memory)", () => {
    let auth: typeof import("./auth.server").auth;

    beforeAll(async () => {
        const { sqlite } = await import("@/lib/db");
        // Apply the generated migration onto the in-memory DB.
        const { readFileSync, readdirSync } = await import("node:fs");
        const { dirname, resolve } = await import("node:path");
        const { fileURLToPath } = await import("node:url");
        const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");
        const files = readdirSync(dir)
            .filter((f) => f.endsWith(".sql"))
            .sort();

        for (const file of files) {
            const sql = readFileSync(resolve(dir, file), "utf8");
            // drizzle SQLite migrations use `--> statement-breakpoint` between statements.
            for (const stmt of sql.split("--> statement-breakpoint")) {
                const trimmed = stmt.trim();

                if (trimmed.length > 0) {
                    sqlite.exec(trimmed);
                }
            }
        }

        ({ auth } = await import("./auth.server"));
    });

    afterAll(async () => {
        const { sqlite } = await import("@/lib/db");
        sqlite.close();
    });

    it("signs up a new email/password user and persists it", async () => {
        const res = await auth.api.signUpEmail({
            body: { email: "smoke@devdashboard.app", password: "supersecret123", name: "Smoke" },
        });

        expect(res.user.email).toBe("smoke@devdashboard.app");
        expect(res.user.id).toBeTruthy();
    });

    it("rejects a wrong password on sign-in", async () => {
        const attempt = auth.api.signInEmail({
            body: { email: "smoke@devdashboard.app", password: "wrong-password" },
        });
        await expect(attempt).rejects.toThrow();
    });

    it("signs in with the correct password", async () => {
        const res = await auth.api.signInEmail({
            body: { email: "smoke@devdashboard.app", password: "supersecret123" },
        });
        expect(res.user.email).toBe("smoke@devdashboard.app");
    });
});
