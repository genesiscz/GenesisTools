import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTodayUsageSummary, recordUsageRequest, setUsageStoreDirForTests } from "@app/ai-proxy/lib/usage/store";
import type { UsageRequestRecord } from "@app/ai-proxy/lib/usage/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { atomicWriteIo } from "@genesiscz/utils/storage/atomic-file";

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usage-store-"));
    setUsageStoreDirForTests(dir);
});

afterEach(() => {
    setUsageStoreDirForTests(null);
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
    it("copies an unreadable daily.json aside byte for byte before a request replaces it", () => {
        const torn = '{"version":1,"days":{"2026-07-01":{"work/grok/grok-4-fast":{"requests":900,';
        writeFileSync(dailyFile(), torn);

        // A status read counts from zero and changes nothing on disk.
        expect(getTodayUsageSummary("work").requests).toBe(0);
        expect(readFileSync(dailyFile(), "utf8")).toBe(torn);
        expect(corruptCopies()).toEqual([]);

        recordUsageRequest(request());

        const copies = corruptCopies();
        expect(copies).toHaveLength(1);
        expect(readFileSync(join(dir, copies[0]), "utf8")).toBe(torn);
        setUsageStoreDirForTests(dir);
        expect(getTodayUsageSummary("work").requests).toBe(1);
    });

    it("a readable daily.json keeps counting and is never copied aside", () => {
        plantValidDaily(4);

        recordUsageRequest(request());

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
            attempts = failing.mock.calls.length;
        } finally {
            failing.mockRestore();
        }

        expect(attempts).toBeGreaterThan(0);
        expect(readFileSync(dailyFile(), "utf8")).toBe(before);
    });
});
