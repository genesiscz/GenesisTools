import { describe, expect, test } from "bun:test";
import cp from "node:child_process";
import { skip } from "@genesiscz/utils/test/skip";
import { withSpawnCounter } from "./spawn-counter";

describe.skipIf(skip.onWindows)("withSpawnCounter", () => {
    test("counts Bun.spawnSync and records its argv", async () => {
        const { result, count, spawns } = await withSpawnCounter(async () => {
            Bun.spawnSync(["true"], { env: process.env });
            return "done";
        });

        expect(result).toBe("done");
        expect(count).toBe(1);
        expect(spawns[0].cmd).toEqual(["true"]);
        expect(spawns[0].sync).toBe(true);
        expect(spawns[0].at).toBeGreaterThanOrEqual(0);
    });

    test("counts Bun.spawn called with an options object", async () => {
        const { spawns } = await withSpawnCounter(async () => {
            const proc = Bun.spawn({ cmd: ["true"], stdout: "ignore", stderr: "ignore", env: process.env });
            await proc.exited;
        });

        expect(spawns).toHaveLength(1);
        expect(spawns[0].cmd).toEqual(["true"]);
        expect(spawns[0].sync).toBe(false);
    });

    test("catches node:child_process.execSync, which funnels into Bun.spawnSync", async () => {
        const { count, spawns } = await withSpawnCounter(async () => {
            cp.execSync("true");
        });

        // Exactly one: patching the child_process methods as well would double-count.
        expect(count).toBe(1);
        expect(spawns[0].sync).toBe(true);
    });

    test("catches the async node:child_process.spawn as a Bun.spawn", async () => {
        const { count, spawns } = await withSpawnCounter(async () => {
            await new Promise<void>((resolve) => {
                const child = cp.spawn("true", []);
                child.on("close", () => resolve());
            });
        });

        expect(count).toBe(1);
        expect(spawns[0].sync).toBe(false);
    });

    test("does NOT see Bun.$, which is the documented floor in the count", async () => {
        const { result, count } = await withSpawnCounter(async () => {
            return await Bun.$`/bin/date`.quiet().text();
        });

        expect(result.trim().length).toBeGreaterThan(0);
        expect(count).toBe(0);
    });

    test("restores Bun.spawn and Bun.spawnSync when the body throws", async () => {
        const beforeSpawn = Bun.spawn;
        const beforeSpawnSync = Bun.spawnSync;

        await expect(
            withSpawnCounter(async () => {
                Bun.spawnSync(["true"], { env: process.env });
                throw new Error("boom");
            })
        ).rejects.toThrow("boom");

        expect(Bun.spawn).toBe(beforeSpawn);
        expect(Bun.spawnSync).toBe(beforeSpawnSync);
    });

    test("nests, so an inner window is also visible to the outer one", async () => {
        const outer = await withSpawnCounter(async () => {
            return await withSpawnCounter(async () => {
                Bun.spawnSync(["true"], { env: process.env });
            });
        });

        expect(outer.count).toBe(1);
        expect(outer.result.count).toBe(1);
    });
});
