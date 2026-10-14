import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTodayUsageSummary, recordUsageRequest, setUsageStoreDirForTests } from "@app/ai-proxy/lib/usage/store";
import type { UsageRequestRecord } from "@app/ai-proxy/lib/usage/types";
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
});
