import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { CLAUDE_ALL_ACCOUNT_ID, UNBOUND_ACCOUNT_ID } from "@genesiscz/utils/ai/usage";
import { SafeJSON } from "@genesiscz/utils/json";
import { Storage } from "@genesiscz/utils/storage/storage";
import { setupStorageSandbox } from "@genesiscz/utils/storage/test-sandbox";
import { claudeDriver } from "./drivers/claude";
import { codexDriver } from "./drivers/codex";
import { isolateAgentHomeEnv } from "./drivers/test-env";
import type { DriverRoot, MonitorDriver } from "./drivers/types";
import { buildSpendSeries, type SpendSeriesOptions, UnsupportedGrainError } from "./series";

setupStorageSandbox();
// CODEX_HOME / CLAUDE_CONFIG_DIR would drag the real transcript trees in.
isolateAgentHomeEnv();

/** Fixture handles only — never a live account name. */
const WORK = "acc_work";
const SHOP = "acc_shop";

function account(id: string, name: string): AccountEntry {
    return { id, name, provider: "openai-sub", credentials: {} } as AccountEntry;
}

/** claude-3-5-haiku: $0.8/M input. */
function claudeLine(id: string, iso: string, usage: Record<string, number>): string {
    return `${SafeJSON.stringify({
        type: "assistant",
        timestamp: iso,
        cwd: "/tmp/proj",
        sessionId: "s1",
        message: { id, model: "claude-3-5-haiku", usage },
    })}\n`;
}

/** gpt-5: $10/M output. One turn_context to pin the model, one token_count. */
function codexRollout(iso: string, outputTokens: number): string {
    const turnContext = SafeJSON.stringify({
        timestamp: iso,
        type: "turn_context",
        payload: { turn_id: "turn-1", cwd: "/tmp/proj", model: "gpt-5", effort: "medium" },
    });
    const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: outputTokens, total_tokens: outputTokens };
    const tokenCount = SafeJSON.stringify({
        timestamp: iso,
        type: "event_msg",
        payload: {
            type: "token_count",
            info: { total_token_usage: usage, last_token_usage: usage, model_context_window: 258_400 },
        },
    });

    return `${turnContext}\n${tokenCount}\n`;
}

/**
 * A codex driver whose roots are the three fixture homes, two of them bound.
 * Stands in for what `rootsForAccounts` returns once the openai-sub plugin
 * ships `spendScope`; the series code path is identical either way.
 */
function boundCodexDriver(homes: { work: string; shop: string; loose: string }): MonitorDriver {
    return {
        ...codexDriver,
        roots: () => [join(homes.work, "sessions"), join(homes.shop, "sessions"), join(homes.loose, "sessions")],
        rootsForAccounts: (): DriverRoot[] => [
            { path: join(homes.work, "sessions"), accountId: WORK, home: homes.work },
            { path: join(homes.shop, "sessions"), accountId: SHOP, home: homes.shop },
        ],
    };
}

/** Yesterday at `hour`, local. Always in the past, always one civil day. */
function yesterdayAt(hour: number): string {
    const now = new Date();

    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, hour, 0).toISOString();
}

function window(days = 2): { from: string; to: string } {
    const now = Date.now();

    return { from: new Date(now - days * 86_400_000).toISOString(), to: new Date(now + 3_600_000).toISOString() };
}

describe("buildSpendSeries", () => {
    let home: string;
    let homes: { work: string; shop: string; loose: string };
    let storage: Storage;
    let options: SpendSeriesOptions;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "ai-spend-series-"));
        homes = {
            work: join(home, ".codex-work"),
            shop: join(home, ".codex-shop"),
            loose: join(home, ".codex-loose"),
        };
        storage = new Storage("ai-spend");

        for (const dir of Object.values(homes)) {
            mkdirSync(join(dir, "sessions"), { recursive: true });
        }

        writeFileSync(join(homes.work, "sessions", "rollout-work.jsonl"), codexRollout(yesterdayAt(9), 100_000));
        writeFileSync(join(homes.shop, "sessions", "rollout-shop.jsonl"), codexRollout(yesterdayAt(10), 200_000));
        writeFileSync(join(homes.loose, "sessions", "rollout-loose.jsonl"), codexRollout(yesterdayAt(11), 300_000));

        options = {
            storage,
            accounts: [account(WORK, "work"), account(SHOP, "shop")],
            drivers: [boundCodexDriver(homes)],
        };
    });

    afterEach(() => {
        rmSync(home, { recursive: true, force: true });
    });

    test("byAccount splits two bound homes from the unbound one", async () => {
        const result = await buildSpendSeries({ ...window(), grain: "day" }, options);

        expect(result.points).toHaveLength(1);
        expect(Object.keys(result.points[0].byAccount).sort()).toEqual([SHOP, WORK, UNBOUND_ACCOUNT_ID].sort());
        expect(result.points[0].byAccount[WORK].tokens).toBe(100_000);
        expect(result.points[0].byAccount[SHOP].tokens).toBe(200_000);
        expect(result.points[0].byAccount[UNBOUND_ACCOUNT_ID].tokens).toBe(300_000);
        expect(result.points[0].tokens).toBe(600_000);
        // gpt-5 output is $10/Mtok, so 0.6M output is $6.00.
        expect(result.points[0].costUsd).toBeCloseTo(6, 6);
        expect(result.unpriced).toBe(0);
    });

    test("the legend names bound accounts and keeps the synthetic unbound id", async () => {
        const result = await buildSpendSeries({ ...window(), grain: "day" }, options);
        const byId = new Map(result.accounts.map((ref) => [ref.accountId, ref]));

        expect(byId.get(WORK)?.accountName).toBe("work");
        expect(byId.get(WORK)?.provider).toBe("openai-sub");
        expect(byId.get(SHOP)?.accountName).toBe("shop");
        expect(byId.get(UNBOUND_ACCOUNT_ID)?.accountName).toBe(UNBOUND_ACCOUNT_ID);
    });

    test("hour grain splits three events of one local day into three buckets", async () => {
        const result = await buildSpendSeries({ ...window(), grain: "hour" }, options);

        expect(result.points).toHaveLength(3);
        expect(result.points.map((point) => point.t.slice(-2))).toEqual(["09", "10", "11"]);
        expect(result.points.map((point) => point.tokens)).toEqual([100_000, 200_000, 300_000]);
    });

    test("accountIds filters the series and week grain folds the day into one bucket", async () => {
        const filtered = await buildSpendSeries({ ...window(), grain: "week", accountIds: [WORK] }, options);

        expect(filtered.points).toHaveLength(1);
        expect(Object.keys(filtered.points[0].byAccount)).toEqual([WORK]);
        expect(filtered.points[0].tokens).toBe(100_000);
    });

    test("byModel splits each point when asked, and is absent otherwise", async () => {
        const withModel = await buildSpendSeries({ ...window(), grain: "day", byModel: true }, options);
        expect(withModel.points[0].byModel?.["gpt-5"].tokens).toBe(600_000);

        const without = await buildSpendSeries({ ...window(), grain: "day" }, options);
        expect(without.points[0].byModel).toBeUndefined();
    });

    test("an unchanged file is never re-read on the second call", async () => {
        await buildSpendSeries({ ...window(), grain: "day" }, options);

        const opened: string[] = [];
        const second = await buildSpendSeries(
            { ...window(), grain: "day" },
            {
                ...options,
                readTailFn: (path) => {
                    opened.push(path);

                    return "";
                },
            }
        );

        expect(opened).toEqual([]);
        // Negative control: the cached numbers are still the real ones.
        expect(second.points[0].tokens).toBe(600_000);
    });

    test("events older than the retention window are dropped from the cache", async () => {
        const old = new Date(Date.now() - 200 * 86_400_000);
        const oldFile = join(homes.work, "sessions", "rollout-old.jsonl");
        writeFileSync(oldFile, codexRollout(old.toISOString(), 900_000));

        await buildSpendSeries(
            { from: old.toISOString(), to: new Date(Date.now() + 3_600_000).toISOString(), grain: "day" },
            options
        );

        const cache = SafeJSON.parse(readFileSync(join(storage.getCacheDir(), "events-cache.json"), "utf8"), {
            strict: true,
        }) as { files: Record<string, { events: unknown[] }> };
        expect(cache.files[oldFile].events).toEqual([]);
        // Negative control: the in-window file kept its event.
        expect(cache.files[join(homes.work, "sessions", "rollout-work.jsonl")].events).toHaveLength(1);
    });

    test("claude transcripts report as one row, never split per anthropic account", async () => {
        const projects = join(home, ".claude", "projects", "p1");
        mkdirSync(projects, { recursive: true });
        writeFileSync(join(projects, "s1.jsonl"), claudeLine("m1", yesterdayAt(12), { input_tokens: 1_000_000 }));

        const result = await buildSpendSeries(
            { ...window(), grain: "day", home, sources: ["claude"] },
            { storage, accounts: [account(WORK, "work")], drivers: [claudeDriver] }
        );

        expect(Object.keys(result.points[0].byAccount)).toEqual([CLAUDE_ALL_ACCOUNT_ID]);
        expect(result.accounts).toEqual([
            { accountId: CLAUDE_ALL_ACCOUNT_ID, accountName: "claude (all accounts)", provider: "anthropic-sub" },
        ]);
        expect(result.points[0].costUsd).toBeCloseTo(0.8, 6);
    });

    test("grain minute is rejected: transcripts are hour-resolution at best", async () => {
        await expect(buildSpendSeries({ ...window(), grain: "minute" }, options)).rejects.toThrow(
            UnsupportedGrainError
        );
    });

    test("an unknown timeZone is named up front, not thrown by Intl inside the loop", async () => {
        await expect(
            buildSpendSeries({ ...window(), grain: "day" }, { ...options, timeZone: "Not/AZone" })
        ).rejects.toThrow(/unknown timeZone "Not\/AZone"/);
    });

    test("negative control: a real IANA zone still buckets", async () => {
        const result = await buildSpendSeries({ ...window(), grain: "day" }, { ...options, timeZone: "Europe/Prague" });

        expect(result.points).toHaveLength(1);
        expect(result.points[0].tokens).toBe(600_000);
    });

    test('an account id of "__proto__" gets its own bucket rather than Object.prototype', async () => {
        const evil = "__proto__";
        const result = await buildSpendSeries(
            { ...window(), grain: "day" },
            {
                storage,
                accounts: [account(evil, "work")],
                drivers: [
                    {
                        ...codexDriver,
                        roots: () => [join(homes.work, "sessions")],
                        rootsForAccounts: (): DriverRoot[] => [
                            { path: join(homes.work, "sessions"), accountId: evil, home: homes.work },
                        ],
                    },
                ],
            }
        );

        expect(Object.keys(result.points[0].byAccount)).toEqual([evil]);
        expect(result.points[0].byAccount[evil].tokens).toBe(100_000);
        // The canary: on a plain object the running totals land here instead.
        expect(Object.prototype).not.toHaveProperty("tokens");
        expect(Object.prototype).not.toHaveProperty("costUsd");
    });

    test("a file whose mtime predates the window is never opened", async () => {
        const stale = join(homes.work, "sessions", "rollout-stale.jsonl");
        writeFileSync(stale, codexRollout(new Date(Date.now() - 30 * 86_400_000).toISOString(), 500_000));
        const old = new Date(Date.now() - 30 * 86_400_000);
        utimesSync(stale, old, old);

        const opened: string[] = [];
        const result = await buildSpendSeries(
            { ...window(), grain: "day" },
            {
                ...options,
                readTailFn: (path, offset, size) => {
                    opened.push(path);

                    return readFileSync(path, "utf8").slice(offset, size);
                },
            }
        );

        expect(opened.some((path) => path.includes("rollout-stale"))).toBe(false);
        expect(result.points[0].tokens).toBe(600_000);
    });
});
