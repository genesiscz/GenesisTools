import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    getTodayUsageSummary,
    readBillingStore,
    recordUsageRequest,
    saveBillingSnapshot,
    setUsageStoreDirForTests,
} from "@app/ai-proxy/lib/usage/store";
import type { UsageRequestRecord } from "@app/ai-proxy/lib/usage/types";
import { hitPercent } from "@genesiscz/utils/ai/usage/cache-stats";
import { SafeJSON } from "@genesiscz/utils/json";
import { atomicWriteIo } from "@genesiscz/utils/storage/atomic-file";

let dir: string;
let timers = spyOn(globalThis, "setTimeout");

/** Drive the real scheduled callback without making every persistence test sleep for an interval. */
function flushScheduledWrite(): void {
    const callback = timers.mock.calls.at(-1)?.[0];
    expect(typeof callback).toBe("function");

    if (typeof callback === "function") {
        callback();
    }
}

beforeEach(() => {
    timers = spyOn(globalThis, "setTimeout");
    timers.mockClear();
    dir = mkdtempSync(join(tmpdir(), "usage-store-"));
    setUsageStoreDirForTests(dir);
});

afterEach(() => {
    setUsageStoreDirForTests(null);
    timers.mockRestore();
    rmSync(dir, { recursive: true, force: true });
});

function dailyFile(): string {
    return join(dir, "daily.json");
}

function corruptCopies(): string[] {
    return readdirSync(dir).filter((name) => name.startsWith("daily.json.corrupt-"));
}

/** The store keys days by LOCAL date. */
function todayKey(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function request(): UsageRequestRecord {
    return {
        ts: new Date().toISOString(),
        account: "work",
        provider: "grok-subscription",
        proxyModel: "work/grok/grok-4-fast",
        upstreamModel: "grok-4-fast",
        path: "/v1/chat/completions",
        status: 200,
        elapsedMs: 10,
        stream: false,
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
}

function plantValidDaily(requests: number): string {
    const text = `${SafeJSON.stringify({
        version: 1,
        days: {
            [todayKey()]: {
                "work/work/grok/grok-4-fast": {
                    requests,
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0,
                    errors: 0,
                    rate_limits: 0,
                },
            },
        },
    })}\n`;
    writeFileSync(dailyFile(), text);
    return text;
}

describe("daily usage store", () => {
    it("coalesces a burst, then schedules another flush only when new usage arrives", () => {
        const before = plantValidDaily(4);
        const fsync = spyOn(atomicWriteIo, "fsyncSync");

        try {
            for (let i = 0; i < 50; i++) {
                recordUsageRequest(request());
            }

            expect(fsync).not.toHaveBeenCalled();
            expect(readFileSync(dailyFile(), "utf8")).toBe(before);
            expect(timers).toHaveBeenCalledTimes(1);
            expect(timers.mock.calls[0][1]).toBe(250);
            flushScheduledWrite();
            expect(fsync).toHaveBeenCalledTimes(1);
            expect(getTodayUsageSummary("work").requests).toBe(54);
            flushScheduledWrite();
            expect(fsync).toHaveBeenCalledTimes(1);

            recordUsageRequest(request());
            expect(timers).toHaveBeenCalledTimes(2);
            expect(fsync).toHaveBeenCalledTimes(1);
            flushScheduledWrite();
            expect(fsync).toHaveBeenCalledTimes(2);
            setUsageStoreDirForTests(dir);
            expect(getTodayUsageSummary("work").requests).toBe(55);
        } finally {
            fsync.mockRestore();
        }
    });

    it("flushes pending usage on process exit before the unreferenced timer fires", async () => {
        const child = Bun.spawn(
            [
                process.execPath,
                "-e",
                `
                import { recordUsageRequest, setUsageStoreDirForTests } from "./src/ai-proxy/lib/usage/store.ts";
                setUsageStoreDirForTests(${SafeJSON.stringify(dir)});
                recordUsageRequest(${SafeJSON.stringify(request())});
                process.exit(0);
            `,
            ],
            { cwd: join(import.meta.dir, "../../../.."), env: process.env, stdout: "pipe", stderr: "pipe" }
        );
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        expect(stderr).toBe("");
        expect(code).toBe(0);
        setUsageStoreDirForTests(dir);
        expect(getTodayUsageSummary("work").requests).toBe(1);
    });

    it("retries the latest dirty aggregate on exit after a failed interval flush", () => {
        plantValidDaily(4);
        recordUsageRequest(request());
        const fail = spyOn(atomicWriteIo, "writeSync").mockImplementation(() => {
            throw new Error("ENOSPC");
        });

        try {
            flushScheduledWrite();
        } finally {
            fail.mockRestore();
        }

        const exitFlush = process.listeners("exit").find((listener) => listener.name === "flushDailyStore");
        expect(exitFlush).toBeDefined();
        exitFlush?.(0);
        setUsageStoreDirForTests(dir);
        expect(getTodayUsageSummary("work").requests).toBe(5);
    });

    it("copies an unreadable daily.json aside byte for byte before a request replaces it", () => {
        const torn = '{"version":1,"days":{"2026-07-01":{"work/grok/grok-4-fast":{"requests":900,';
        writeFileSync(dailyFile(), torn);

        // A status read counts from zero and changes nothing on disk.
        expect(getTodayUsageSummary("work").requests).toBe(0);
        expect(readFileSync(dailyFile(), "utf8")).toBe(torn);
        expect(corruptCopies()).toEqual([]);

        recordUsageRequest(request());
        flushScheduledWrite();

        const copies = corruptCopies();
        expect(copies).toHaveLength(1);
        expect(readFileSync(join(dir, copies[0]), "utf8")).toBe(torn);
        setUsageStoreDirForTests(dir);
        expect(getTodayUsageSummary("work").requests).toBe(1);
    });

    it("a readable daily.json keeps counting and is never copied aside", () => {
        plantValidDaily(4);

        recordUsageRequest(request());
        flushScheduledWrite();

        setUsageStoreDirForTests(dir);
        expect(getTodayUsageSummary("work").requests).toBe(5);
        expect(corruptCopies()).toEqual([]);
    });

    it("a write that fails halfway leaves the previous daily.json byte-identical", () => {
        const before = plantValidDaily(4);
        const failing = spyOn(atomicWriteIo, "writeSync").mockImplementation(() => {
            throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        });

        let attempts = 0;

        try {
            recordUsageRequest(request());
            flushScheduledWrite();
            attempts = failing.mock.calls.length;
        } finally {
            failing.mockRestore();
        }

        expect(attempts).toBeGreaterThan(0);
        expect(readFileSync(dailyFile(), "utf8")).toBe(before);
    });

    it("books cache read, cache write, uncached input and reasoning in both usage conventions", () => {
        // OpenAI shape (Codex, Grok): the cached count is a part of prompt_tokens.
        recordUsageRequest({
            ...request(),
            usage: {
                prompt_tokens: 1000,
                completion_tokens: 20,
                total_tokens: 1020,
                cached_prompt_tokens: 900,
                reasoning_tokens: 12,
            },
        });
        // Anthropic shape: the cache counts sit outside prompt_tokens.
        recordUsageRequest({
            ...request(),
            usage: {
                prompt_tokens: 50,
                completion_tokens: 5,
                total_tokens: 55,
                cache_read_input_tokens: 400,
                cache_creation_input_tokens: 150,
            },
        });
        flushScheduledWrite();

        const today = getTodayUsageSummary("work");
        const split = {
            uncached: today.uncached_input_tokens ?? 0,
            cacheRead: today.cache_read_tokens ?? 0,
            cacheWrite: today.cache_write_tokens ?? 0,
        };

        expect(split).toEqual({ uncached: 150, cacheRead: 1300, cacheWrite: 150 });
        expect(today.reasoning_tokens).toBe(12);
        expect(hitPercent(split)).toBeCloseTo((1300 / 1600) * 100, 6);
        expect(hitPercent({ uncached: 0, cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
    });
});

describe("billing store: per-provider details nest under details", () => {
    const grokBilling = {
        monthlyLimit: { val: 100 },
        used: { val: 42 },
        onDemandCap: { val: 0 },
        billingPeriodStart: "2026-06-01",
        billingPeriodEnd: "2026-07-01",
    };
    const base = { fetchedAt: "2026-10-28T10:00:00.000Z", tier: "Premium", summary: "42% used" };

    function billingFile(): string {
        return join(dir, "billing.json");
    }

    function plantBilling(accounts: Record<string, unknown>): void {
        writeFileSync(billingFile(), `${SafeJSON.stringify({ version: 1, accounts })}\n`);
    }

    function reload(): ReturnType<typeof readBillingStore> {
        setUsageStoreDirForTests(dir);
        return readBillingStore();
    }

    it("moves the flat grok and copilot keys, and the older billing/settings pair, into details", () => {
        plantBilling({
            work: { ...base, grok: { billing: grokBilling } },
            personal: { ...base, tier: "individual", copilot: { plan: "individual", quotaRemaining: 10 } },
            side: { ...base, billing: grokBilling, settings: { subscription_tier_display: "Premium" } },
        });

        expect(reload().accounts).toEqual({
            work: { ...base, details: { grok: { billing: grokBilling } } },
            personal: { ...base, tier: "individual", details: { copilot: { plan: "individual", quotaRemaining: 10 } } },
            side: {
                ...base,
                details: { grok: { billing: grokBilling, settings: { subscription_tier_display: "Premium" } } },
            },
        });
    });

    it("keeps details when both shapes are present, and the old key only fills a missing details", () => {
        const stale = { ...grokBilling, used: { val: 1 } };
        plantBilling({
            work: { ...base, details: { grok: { billing: grokBilling } }, grok: { billing: stale } },
            personal: { ...base, details: { copilot: { plan: "business" } }, copilot: { plan: "individual" } },
        });

        expect(reload().accounts).toEqual({
            work: { ...base, details: { grok: { billing: grokBilling } } },
            personal: { ...base, details: { copilot: { plan: "business" } } },
        });
    });

    it("changes nothing on a second load of the migrated store", () => {
        plantBilling({
            work: { ...base, grok: { billing: grokBilling } },
            personal: { ...base, copilot: { plan: "individual" } },
            plain: { ...base },
        });
        const first = reload();
        writeFileSync(billingFile(), `${SafeJSON.stringify(first)}\n`);

        expect(reload()).toEqual(first);
    });

    it("writes only the new shape on the next save", () => {
        plantBilling({ work: { ...base, grok: { billing: grokBilling } } });

        saveBillingSnapshot("personal", { ...base, details: { copilot: { plan: "individual" } } });
        const onDisk = SafeJSON.parse(readFileSync(billingFile(), "utf-8"));

        expect(onDisk.accounts).toEqual({
            work: { ...base, details: { grok: { billing: grokBilling } } },
            personal: { ...base, details: { copilot: { plan: "individual" } } },
        });
    });
});
