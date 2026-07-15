import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { startServer } from "@app/youtube/lib/server";

describe("youtube server ledger + usage-summary routes", () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "youtube-server-ledger-"));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    async function registeredToken(port: number, email: string): Promise<string> {
        const res = await fetch(`http://localhost:${port}/api/v1/users/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: SafeJSON.stringify({ email, password: "hunter22" }),
        });
        const body = (await res.json()) as { token: string };
        return body.token;
    }

    it("GET usage-summary returns the exact shape (days/byReason/month)", async () => {
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

        try {
            const token = await registeredToken(handle.port, "summary-user@example.com");
            const res = await fetch(`http://localhost:${handle.port}/api/v1/users/usage-summary`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const body = (await res.json()) as {
                days: Array<{ date: string; spent: number; earned: number }>;
                byReason: Array<{ reason: string; spent: number; count: number }>;
                month: { spent: number; earned: number };
            };

            expect(res.status).toBe(200);
            expect(body.days).toHaveLength(30);
            expect(body.byReason.some((r) => r.reason === "register-grant")).toBe(true);
            expect(body.month.earned).toBeGreaterThanOrEqual(100);
        } finally {
            await handle.stop();
        }
    });

    it("GET usage-summary requires auth", async () => {
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

        try {
            const res = await fetch(`http://localhost:${handle.port}/api/v1/users/usage-summary`);
            expect(res.status).toBe(401);
        } finally {
            await handle.stop();
        }
    });

    it("GET ledger paginates newest-first with a stable keyset order", async () => {
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

        try {
            const token = await registeredToken(handle.port, "ledger-user@example.com");
            handle.youtube.db.spendCredits(1, 5, "ask");
            handle.youtube.db.spendCredits(1, 5, "ask");
            handle.youtube.db.grantCredits(1, 2000, "stripe:cs_ledger_route");

            const firstRes = await fetch(`http://localhost:${handle.port}/api/v1/users/ledger?limit=2`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const firstBody = (await firstRes.json()) as {
                rows: Array<{ id: number; reason: string }>;
                nextBefore: number | null;
            };

            expect(firstRes.status).toBe(200);
            expect(firstBody.rows).toHaveLength(2);
            expect(firstBody.rows[0].reason).toBe("stripe:cs_ledger_route");
            expect(firstBody.nextBefore).not.toBeNull();

            const secondRes = await fetch(
                `http://localhost:${handle.port}/api/v1/users/ledger?limit=2&before=${firstBody.nextBefore}`,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            const secondBody = (await secondRes.json()) as { rows: Array<{ id: number }> };

            const firstIds = new Set(firstBody.rows.map((r) => r.id));
            for (const row of secondBody.rows) {
                expect(firstIds.has(row.id)).toBe(false);
            }
        } finally {
            await handle.stop();
        }
    });
});
