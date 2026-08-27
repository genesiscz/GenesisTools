import { describe, expect, test } from "bun:test";
import { createMountCache } from "./mount-cache";

interface Mount {
    key: string;
    closed: boolean;
}

function trackingCache(max: number) {
    const started: string[] = [];
    const closed: string[] = [];
    let resolvers: Array<() => void> = [];

    const cache = createMountCache<Mount>({
        max,
        start: async (key) => {
            started.push(key);
            await new Promise<void>((r) => resolvers.push(r));

            if (key.startsWith("bad")) {
                throw new Error(`cannot start ${key}`);
            }

            return { key, closed: false };
        },
        close: async (value) => {
            value.closed = true;
            closed.push(value.key);
        },
    });

    const flush = (): void => {
        const pending = resolvers;
        resolvers = [];

        for (const r of pending) {
            r();
        }
    };

    return { cache, started, closed, flush };
}

describe("createMountCache", () => {
    test("concurrent requests for one mount share a SINGLE start", async () => {
        const { cache, started, flush } = trackingCache(4);
        const a = cache.get("notes");
        const b = cache.get("notes");
        flush();

        expect(await a).toBe(await b);
        expect(started).toEqual(["notes"]);
    });

    test("a failed start is not cached, so the next request retries", async () => {
        const { cache, started, flush } = trackingCache(4);
        const first = cache.get("bad-one");
        flush();
        await expect(first).rejects.toThrow(/cannot start/);

        expect(cache.keys()).toEqual([]);

        const second = cache.get("bad-one");
        flush();
        await expect(second).rejects.toThrow(/cannot start/);
        expect(started).toEqual(["bad-one", "bad-one"]);
    });

    test("a ready mount is reused instead of restarted", async () => {
        const { cache, started, flush } = trackingCache(4);
        const first = cache.get("notes");
        flush();
        await first;

        const again = await cache.get("notes");
        expect(await first).toBe(again);
        expect(started).toEqual(["notes"]);
    });

    test("the map is BOUNDED: the least recently used mount is closed on overflow", async () => {
        const { cache, closed, flush } = trackingCache(2);
        const a = cache.get("a");
        const b = cache.get("b");
        flush();
        await Promise.all([a, b]);

        // Touch "a" so "b" becomes the least recently used one.
        await cache.get("a");

        const c = cache.get("c");
        flush();
        await c;
        await Promise.resolve();
        await Promise.resolve();

        expect(cache.keys()).toEqual(["a", "c"]);
        expect(closed).toEqual(["b"]);
        expect((await b).closed).toBe(true);
    });

    test("closeAll closes every live mount and empties the cache", async () => {
        const { cache, closed, flush } = trackingCache(4);
        const a = cache.get("a");
        const b = cache.get("b");
        flush();
        await Promise.all([a, b]);

        await cache.closeAll();

        expect(closed.sort()).toEqual(["a", "b"]);
        expect(cache.keys()).toEqual([]);
    });

    test("closeAll shuts the mounts down CONCURRENTLY", async () => {
        // Each close waits until both have started. One after the other, the
        // first one never sees the second and closeAll never settles.
        let release = (): void => undefined;
        const bothStarted = new Promise<void>((r) => {
            release = r;
        });
        const inFlight = new Set<string>();

        const cache = createMountCache<string>({
            start: (key) => Promise.resolve(key),
            close: async (value) => {
                inFlight.add(value);

                if (inFlight.size === 2) {
                    release();
                }

                await bothStarted;
            },
        });
        await Promise.all([cache.get("a"), cache.get("b")]);

        const done = await Promise.race([
            cache.closeAll().then(() => "closed"),
            new Promise((r) => setTimeout(() => r("timed out"), 500)),
        ]);

        expect(done).toBe("closed");
        expect(inFlight).toEqual(new Set(["a", "b"]));
    });

    test("closeAll still closes the rest when one mount close throws", async () => {
        const closed: string[] = [];
        const cache = createMountCache<string>({
            start: (key) => Promise.resolve(key),
            close: async (value) => {
                if (value === "bad") {
                    throw new Error("close failed");
                }

                closed.push(value);
            },
        });
        await Promise.all([cache.get("a"), cache.get("bad"), cache.get("b")]);

        await cache.closeAll();

        expect(closed.sort()).toEqual(["a", "b"]);
        expect(cache.keys()).toEqual([]);
    });
});
