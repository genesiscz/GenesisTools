import { describe, expect, it } from "bun:test";
import { WorkerPool } from "./pool";

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const startedAt = Date.now();

    while (!predicate()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error("timed out waiting for predicate");
        }

        await Bun.sleep(2);
    }
}

function makeQueue() {
    const items: number[] = [];
    const done: number[] = [];
    let next = 1;

    return {
        items,
        done,
        push(count: number) {
            for (let i = 0; i < count; i++) {
                items.push(next++);
            }
        },
        claim: () => items.shift() ?? null,
    };
}

describe("WorkerPool", () => {
    it("starts with no workers when min is 0 and claims pre-existing work on start", async () => {
        const queue = makeQueue();
        queue.push(3);
        const pool = new WorkerPool<number>({
            name: "t",
            max: 4,
            claim: queue.claim,
            run: async (item) => {
                queue.done.push(item);
            },
            pollMs: 0,
            idleTeardownMs: 20,
        });

        expect(pool.getStats().workers).toBe(0);
        pool.start();
        await waitFor(() => queue.done.length === 3);
        await waitFor(() => pool.getStats().workers === 0);
        expect([...queue.done].sort((a, b) => a - b)).toEqual([1, 2, 3]);
        await pool.stop();
    });

    it("scales up to max on a burst and tears idle workers down afterwards", async () => {
        const queue = makeQueue();
        let inFlight = 0;
        let peak = 0;
        const pool = new WorkerPool<number>({
            name: "t",
            max: 4,
            claim: queue.claim,
            run: async (item) => {
                inFlight++;
                peak = Math.max(peak, inFlight);
                await Bun.sleep(15);
                inFlight--;
                queue.done.push(item);
            },
            pollMs: 0,
            idleTeardownMs: 30,
        });
        pool.start();

        queue.push(12);
        pool.kick();
        await waitFor(() => queue.done.length === 12);

        expect(peak).toBe(4);
        expect(pool.getStats().spawned).toBeLessThanOrEqual(4);
        await waitFor(() => pool.getStats().workers === 0, 1000);
        expect(pool.getStats().retired).toBe(pool.getStats().spawned);
        await pool.stop();
    });

    it("keeps min workers resident and wakes them with a kick", async () => {
        const queue = makeQueue();
        const pool = new WorkerPool<number>({
            name: "t",
            max: 2,
            min: 1,
            pendingHint: () => queue.items.length,
            claim: queue.claim,
            run: async (item) => {
                queue.done.push(item);
            },
            pollMs: 0,
            idleTeardownMs: 10,
        });
        pool.start();
        await waitFor(() => pool.getStats().idle === 1);
        await Bun.sleep(30);
        expect(pool.getStats().workers).toBe(1);

        queue.push(1);
        pool.kick();
        await waitFor(() => queue.done.length === 1);
        expect(pool.getStats().spawned).toBe(1);
        await pool.stop();
        expect(pool.getStats().workers).toBe(0);
    });

    it("re-reads max on every scale decision", async () => {
        const queue = makeQueue();
        let max = 1;
        let inFlight = 0;
        let peak = 0;
        const pool = new WorkerPool<number>({
            name: "t",
            max: () => max,
            claim: queue.claim,
            run: async (item) => {
                inFlight++;
                peak = Math.max(peak, inFlight);
                await Bun.sleep(10);
                inFlight--;
                queue.done.push(item);
            },
            pollMs: 0,
            idleTeardownMs: 10,
        });
        pool.start();
        queue.push(6);
        pool.kick();
        await waitFor(() => queue.done.length === 6);
        expect(peak).toBe(1);

        max = 3;
        queue.push(6);
        pool.kick();
        await waitFor(() => queue.done.length === 12);
        expect(peak).toBe(3);
        await pool.stop();
    });

    it("uses pendingHint to spawn several workers on one kick", async () => {
        const queue = makeQueue();
        const pool = new WorkerPool<number>({
            name: "t",
            max: 8,
            spawnPolicy: "one",
            pendingHint: () => queue.items.length,
            claim: queue.claim,
            run: async (item) => {
                await Bun.sleep(20);
                queue.done.push(item);
            },
            pollMs: 0,
            idleTeardownMs: 10,
        });
        pool.start();
        queue.push(5);
        pool.kick();
        await Bun.sleep(5);
        expect(pool.getStats().workers).toBe(5);
        await waitFor(() => queue.done.length === 5);
        await pool.stop();
    });

    it("survives a throwing claim and a throwing run", async () => {
        const errors: string[] = [];
        let claims = 0;
        const pool = new WorkerPool<number>({
            name: "t",
            max: 1,
            claim: () => {
                claims++;

                if (claims === 1) {
                    throw new Error("claim boom");
                }

                return claims === 2 ? 42 : null;
            },
            run: async () => {
                throw new Error("run boom");
            },
            onError: (error, ctx) => {
                errors.push(`${ctx.phase}:${error instanceof Error ? error.message : String(error)}`);
            },
            pollMs: 0,
            idleTeardownMs: 10,
            claimErrorBackoffMs: 5,
        });
        pool.start();
        await waitFor(() => errors.length === 2);
        expect(errors).toEqual(["claim:claim boom", "run:run boom"]);
        await pool.stop();
    });

    it("stop wakes parked workers and aborts the signal", async () => {
        let observed: AbortSignal | null = null;
        const pool = new WorkerPool<number>({
            name: "t",
            max: 1,
            min: 1,
            claim: (ctx) => {
                observed = ctx.signal;
                return null;
            },
            run: async () => {},
            pollMs: 0,
            idleTeardownMs: 60_000,
        });
        pool.start();
        await waitFor(() => pool.getStats().idle === 1);
        const stopped = pool.stop();
        await Promise.race([stopped, Bun.sleep(500).then(() => Promise.reject(new Error("stop hung")))]);
        expect(observed).not.toBeNull();
        expect(observed!.aborted).toBe(true);
        expect(pool.getStats().workers).toBe(0);
    });

    it("does not wake parked workers when busy already covers pendingHint", async () => {
        const queue = makeQueue();
        queue.push(4);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let claims = 0;
        const pool = new WorkerPool<number>({
            name: "t",
            max: 6,
            min: 6,
            spawnPolicy: "one",
            pendingHint: () => 3,
            claim: () => {
                claims++;

                return queue.claim();
            },
            run: async (item) => {
                await gate;
                queue.done.push(item);
            },
            pollMs: 0,
            idleTeardownMs: 60_000,
        });
        pool.start();
        await waitFor(() => pool.getStats().busy === 4 && pool.getStats().idle === 2);
        const claimsBeforeKick = claims;
        pool.kick();
        await Bun.sleep(20);
        expect(pool.getStats().busy).toBe(4);
        expect(pool.getStats().idle).toBe(2);
        expect(claims).toBe(claimsBeforeKick);
        release();
        await waitFor(() => queue.done.length === 4);
        await pool.stop();
    });

    it("does not spawn a tourist when pendingHint is 0", async () => {
        const queue = makeQueue();
        const pool = new WorkerPool<number>({
            name: "t",
            max: 4,
            pendingHint: () => 0,
            claim: queue.claim,
            run: async (item) => {
                queue.done.push(item);
            },
            pollMs: 0,
            idleTeardownMs: 60_000,
        });
        pool.start();
        await Bun.sleep(20);
        expect(pool.getStats().workers).toBe(0);
        expect(pool.getStats().spawned).toBe(0);
        await pool.stop();
    });

    it("does not spawn when max is 0", async () => {
        const queue = makeQueue();
        queue.push(3);
        const pool = new WorkerPool<number>({
            name: "t",
            max: () => 0,
            pendingHint: () => queue.items.length,
            claim: queue.claim,
            run: async (item) => {
                queue.done.push(item);
            },
            pollMs: 0,
            idleTeardownMs: 10,
        });
        pool.start();
        pool.kick();
        await Bun.sleep(20);
        expect(pool.getStats().workers).toBe(0);
        expect(queue.done).toEqual([]);
        await pool.stop();
    });

    it("falls back to the poll when no kick arrives", async () => {
        const queue = makeQueue();
        const pool = new WorkerPool<number>({
            name: "t",
            max: 1,
            claim: queue.claim,
            run: async (item) => {
                queue.done.push(item);
            },
            pollMs: 10,
            idleTeardownMs: 5,
        });
        pool.start();
        await Bun.sleep(20);
        queue.push(1);
        await waitFor(() => queue.done.length === 1);
        expect(pool.getStats().kicks).toBeGreaterThan(1);
        await pool.stop();
    });
});
