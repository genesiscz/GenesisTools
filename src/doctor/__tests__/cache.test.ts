import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { readCache, writeCache } from "@app/doctor/lib/cache";
import { cacheFilePath } from "@app/doctor/lib/paths";
import type { AnalyzerResult } from "@app/doctor/lib/types";

let analyzerId: string;

beforeEach(() => {
    analyzerId = `doctor-cache-test-${crypto.randomUUID()}`;
});

afterEach(() => {
    rmSync(cacheFilePath(analyzerId), { force: true });
});

describe("cache", () => {
    it("readCache returns null when no cache exists", async () => {
        const got = await readCache(analyzerId, 60_000);
        expect(got).toBeNull();
    });

    it("writeCache + readCache roundtrip within TTL", async () => {
        const result: AnalyzerResult = {
            analyzerId,
            findings: [],
            durationMs: 100,
            error: null,
            fromCache: false,
            timestamp: new Date().toISOString(),
        };

        await writeCache(analyzerId, result);
        const got = await readCache(analyzerId, 60_000);
        expect(got?.analyzerId).toBe(analyzerId);
    });

    it("readCache returns null when past TTL", async () => {
        const result: AnalyzerResult = {
            analyzerId,
            findings: [],
            durationMs: 100,
            error: null,
            fromCache: false,
            timestamp: new Date(Date.now() - 2 * 60_000).toISOString(),
        };

        await writeCache(analyzerId, result);
        const got = await readCache(analyzerId, 60_000);
        expect(got).toBeNull();
    });
});
