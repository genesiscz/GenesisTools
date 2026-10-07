import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAskDatabase } from "@app/ask/lib/db";
import { showCostTrend, showSummary } from "@app/ask/lib/usage-report";
import { out } from "@genesiscz/utils/logger";
import { UsageDatabase } from "./UsageDatabase";

const dirs: string[] = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

// Regression test: #446 — `tools ask --help` wrote ~/.genesis-tools/ask.sqlite, because the
// module-level usage database opened its file at import time
describe("UsageDatabase", () => {
    it("applies one provider/model scope to every aggregate", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ask-usage-scope-"));
        dirs.push(dir);
        const path = join(dir, "ask.sqlite");
        const writer = openAskDatabase(path);
        for (const [provider, model, cost, tokens] of [
            ["openai", "fixture-small", 1, 10],
            ["anthropic", "fixture-large", 9, 90],
        ] as const) {
            await writer.kysely
                .insertInto("usage_records")
                .values({
                    session_id: provider,
                    provider,
                    model,
                    cost,
                    total_tokens: tokens,
                    input_tokens: tokens,
                    output_tokens: 0,
                    cached_input_tokens: 0,
                    timestamp: new Date().toISOString(),
                    message_index: null,
                })
                .execute();
        }
        writer.close();
        const db = new UsageDatabase(path);
        try {
            for (const scope of [
                { days: 7, provider: "openai" },
                { days: 7, model: "fixture-small" },
                { days: 7, provider: "openai", model: "fixture-small" },
            ]) {
                expect(await db.getTotalUsage(scope)).toMatchObject({ totalCost: 1, totalTokens: 10, messageCount: 1 });
                expect(await db.getDailyUsage(scope)).toMatchObject([{ totalCost: 1, totalTokens: 10 }]);
                expect(await db.getProviderUsage(scope)).toMatchObject([{ provider: "openai", totalCost: 1 }]);
                expect(await db.getModelUsage(scope)).toMatchObject([{ model: "fixture-small", totalCost: 1 }]);
                expect(await db.getCostTrend(scope)).toMatchObject([{ cost: 1 }]);
                expect(await db.getTopModels(10, scope)).toMatchObject([{ model: "fixture-small", totalCost: 1 }]);
            }
            expect(await db.getTotalUsage(7)).toMatchObject({ totalCost: 10, messageCount: 2 });
            expect(await db.getTotalUsage({ model: "absent" })).toMatchObject({ totalCost: 0, messageCount: 0 });
            expect(await db.getDailyUsage({ model: "absent" })).toEqual([]);
            expect(await db.getCostTrend({ model: "absent" })).toEqual([]);
            for (const days of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
                await expect(db.getTotalUsage({ days })).rejects.toThrow("Usage days");
            }
            expect(await db.getTotalUsage({ days: 0 })).toMatchObject({ messageCount: 2 });
        } finally {
            db.close();
        }
    });

    it("prints a cost trend whose days all cost nothing, and a summary with no day limit", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ask-usage-free-"));
        dirs.push(dir);
        const path = join(dir, "ask.sqlite");
        const writer = openAskDatabase(path);
        await writer.kysely
            .insertInto("usage_records")
            .values({
                session_id: "free",
                provider: "local",
                model: "free",
                cost: 0,
                total_tokens: 10,
                input_tokens: 10,
                output_tokens: 0,
                cached_input_tokens: 0,
                timestamp: new Date().toISOString(),
                message_index: null,
            })
            .execute();
        writer.close();
        const db = new UsageDatabase(path);
        const lines: string[] = [];
        const println = spyOn(out, "println").mockImplementation((line?: string) => {
            lines.push(line ?? "");
        });
        try {
            await showCostTrend(db, { model: "free" });
            await showSummary(db, {});
        } finally {
            println.mockRestore();
            db.close();
        }
        expect(lines.some((line) => line.includes("All history"))).toBe(true);
    });

    it("creates no file until it is first used, then works", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ask-usage-"));
        dirs.push(dir);
        const path = join(dir, "ask.sqlite");

        const db = new UsageDatabase(path);
        expect(existsSync(path)).toBe(false);

        expect(await db.getDailyUsage(7)).toEqual([]);
        expect(existsSync(path)).toBe(true);
    });
});
