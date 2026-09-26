import { describe, expect, test } from "bun:test";
import type { OriginDriver, PrInfo, PrLookup } from "@genesiscz/utils/git/origins";
import { Storage } from "@genesiscz/utils/storage";
import {
    cachedPrForHead,
    DEFAULT_PR_LOOKUP_CACHE_SECONDS,
    prLookupCacheKey,
    readPrLookupCacheSeconds,
    writePrLookupCacheSeconds,
} from "./pr-lookup-cache";

/** A fresh cache per test: the suite's real ~/.genesis-tools/hub is never touched. */
let scratch = 0;

function scratchStorage(): Storage {
    scratch += 1;
    return new Storage(`hub-pr-lookup-cache-test-${process.pid}-${scratch}`);
}

function pr(number: number): PrInfo {
    return { number, state: "OPEN", target: "master", url: `https://github.com/acme/web/pull/${number}` };
}

/** Answers `prForHead` in order, repeating the last answer past the end; records every branch asked. */
function fakeDriver(answers: PrLookup[]): { driver: OriginDriver; calls: string[] } {
    const calls: string[] = [];
    let i = 0;
    const driver: OriginDriver = {
        kind: "github",
        async prForHead(branch) {
            calls.push(branch);
            const answer = answers[Math.min(i, answers.length - 1)];
            i += 1;
            return answer;
        },
    };
    return { driver, calls };
}

/** A driver that fails the test if it is ever asked: proves a cache hit never reaches the host. */
function unreachableDriver(): OriginDriver {
    return {
        kind: "github",
        async prForHead() {
            throw new Error("prForHead must not be called: a cache hit was expected");
        },
    };
}

describe("cachedPrForHead", () => {
    test("a hit never reaches the driver", async () => {
        const storage = scratchStorage();
        const { driver, calls } = fakeDriver([{ pr: pr(7), error: null }]);
        const first = await cachedPrForHead({
            driver,
            originUrl: "git@github.com:acme/web.git",
            branch: "feat/x",
            head: "aaa111",
            storage,
        });
        expect(first).toEqual({ pr: pr(7), error: null });
        expect(calls).toEqual(["feat/x"]);

        const second = await cachedPrForHead({
            driver: unreachableDriver(),
            originUrl: "git@github.com:acme/web.git",
            branch: "feat/x",
            head: "aaa111",
            storage,
        });
        expect(second).toEqual({ pr: pr(7), error: null });
    });

    test("a clean 'no PR' answer is cached like a hit", async () => {
        const storage = scratchStorage();
        const { driver } = fakeDriver([{ pr: null, error: null }]);
        await cachedPrForHead({ driver, originUrl: "o", branch: "b", head: "h1", storage });

        const second = await cachedPrForHead({
            driver: unreachableDriver(),
            originUrl: "o",
            branch: "b",
            head: "h1",
            storage,
        });
        expect(second).toEqual({ pr: null, error: null });
    });

    test("a 'no PR' answer expires after 15 s, so a PR opened for the same head shows up", async () => {
        const storage = scratchStorage();
        const { driver, calls } = fakeDriver([
            { pr: null, error: null },
            { pr: pr(7), error: null },
        ]);
        let clock = 1_000_000;
        const now = () => clock;
        const ask = (d: OriginDriver) =>
            cachedPrForHead({ driver: d, originUrl: "o", branch: "b", head: "h", storage, ttlSeconds: 60, now });

        await ask(driver);
        clock += 10_000;
        expect((await ask(unreachableDriver())).pr).toBeNull();

        clock += 6_000; // 16 s: past the "no PR" limit, well inside the 60 s TTL
        expect((await ask(driver)).pr?.number).toBe(7);
        expect(calls).toEqual(["b", "b"]);

        clock += 40_000; // a found PR keeps the full TTL
        expect((await ask(unreachableDriver())).pr?.number).toBe(7);
    });

    test("a head change is a miss by construction", async () => {
        const storage = scratchStorage();
        const { driver, calls } = fakeDriver([
            { pr: pr(1), error: null },
            { pr: pr(2), error: null },
        ]);
        const first = await cachedPrForHead({ driver, originUrl: "o", branch: "b", head: "h1", storage });
        const second = await cachedPrForHead({ driver, originUrl: "o", branch: "b", head: "h2", storage });
        expect(first.pr?.number).toBe(1);
        expect(second.pr?.number).toBe(2);
        expect(calls).toEqual(["b", "b"]);
    });

    test("TTL expiry via an injected clock: a hit inside the window, a miss once it passes", async () => {
        const storage = scratchStorage();
        const { driver, calls } = fakeDriver([
            { pr: pr(1), error: null },
            { pr: pr(2), error: null },
        ]);
        let clock = 1_000_000;
        const now = () => clock;

        await cachedPrForHead({ driver, originUrl: "o", branch: "b", head: "h", storage, ttlSeconds: 60, now });

        clock += 59_000;
        const stillCached = await cachedPrForHead({
            driver: unreachableDriver(),
            originUrl: "o",
            branch: "b",
            head: "h",
            storage,
            ttlSeconds: 60,
            now,
        });
        expect(stillCached.pr?.number).toBe(1);

        clock += 2_000; // 61s since the write: past the 60s TTL
        const expired = await cachedPrForHead({
            driver,
            originUrl: "o",
            branch: "b",
            head: "h",
            storage,
            ttlSeconds: 60,
            now,
        });
        expect(expired.pr?.number).toBe(2);
        expect(calls).toEqual(["b", "b"]);
    });

    test("a failed lookup is never cached: the next call reaches the driver again", async () => {
        const storage = scratchStorage();
        const { driver, calls } = fakeDriver([
            { pr: null, error: "gh exited 1: rate limited" },
            { pr: pr(3), error: null },
        ]);
        const first = await cachedPrForHead({ driver, originUrl: "o", branch: "b", head: "h", storage });
        expect(first).toEqual({ pr: null, error: "gh exited 1: rate limited" });

        const second = await cachedPrForHead({ driver, originUrl: "o", branch: "b", head: "h", storage });
        expect(second).toEqual({ pr: pr(3), error: null });
        expect(calls).toEqual(["b", "b"]);
    });

    test("TTL 0 turns the cache off: every call reaches the driver, nothing is ever written", async () => {
        const storage = scratchStorage();
        const { driver, calls } = fakeDriver([
            { pr: pr(1), error: null },
            { pr: pr(1), error: null },
        ]);
        await cachedPrForHead({ driver, originUrl: "o", branch: "b", head: "h", storage, ttlSeconds: 0 });
        await cachedPrForHead({ driver, originUrl: "o", branch: "b", head: "h", storage, ttlSeconds: 0 });
        expect(calls).toEqual(["b", "b"]);
    });

    test("--fresh skips the read but still refreshes the cache for the next call", async () => {
        const storage = scratchStorage();
        const { driver, calls } = fakeDriver([
            { pr: pr(1), error: null },
            { pr: pr(2), error: null },
        ]);
        await cachedPrForHead({ driver, originUrl: "o", branch: "b", head: "h", storage });
        const fresh = await cachedPrForHead({ driver, originUrl: "o", branch: "b", head: "h", storage, fresh: true });
        expect(fresh.pr?.number).toBe(2);

        const afterFresh = await cachedPrForHead({
            driver: unreachableDriver(),
            originUrl: "o",
            branch: "b",
            head: "h",
            storage,
        });
        expect(afterFresh.pr?.number).toBe(2);
        expect(calls).toEqual(["b", "b"]);
    });

    test("distinct origin, branch or head all produce distinct keys", () => {
        expect(prLookupCacheKey("o1", "b", "h")).not.toBe(prLookupCacheKey("o2", "b", "h"));
        expect(prLookupCacheKey("o", "b1", "h")).not.toBe(prLookupCacheKey("o", "b2", "h"));
        expect(prLookupCacheKey("o", "b", "h1")).not.toBe(prLookupCacheKey("o", "b", "h2"));
    });
});

describe("readPrLookupCacheSeconds / writePrLookupCacheSeconds", () => {
    test("defaults to 60 with nothing saved", async () => {
        const storage = scratchStorage();
        expect(await readPrLookupCacheSeconds(storage)).toBe(DEFAULT_PR_LOOKUP_CACHE_SECONDS);
    });

    test("round-trips a saved value, including 0 (off)", async () => {
        const storage = scratchStorage();
        expect(await writePrLookupCacheSeconds(0, storage)).toBe(0);
        expect(await readPrLookupCacheSeconds(storage)).toBe(0);

        expect(await writePrLookupCacheSeconds(120, storage)).toBe(120);
        expect(await readPrLookupCacheSeconds(storage)).toBe(120);
    });

    test("rejects a negative or non-finite value", async () => {
        const storage = scratchStorage();
        await expect(writePrLookupCacheSeconds(-1, storage)).rejects.toThrow();
        await expect(writePrLookupCacheSeconds(Number.NaN, storage)).rejects.toThrow();
    });
});
