import { describe, expect, test } from "bun:test";
import fs, { statSync as namedStatSync } from "node:fs";
import { withFsCounter } from "./fs-counter";

const DIR = import.meta.dir;
const FILE = import.meta.path;

describe("withFsCounter", () => {
    test("counts a member-access call and returns the body's result", async () => {
        const { result, calls, total } = await withFsCounter(async () => {
            fs.statSync(DIR);
            fs.existsSync(DIR);
            fs.existsSync(DIR);
            return "done";
        });

        expect(result).toBe("done");
        expect(calls.statSync).toBe(1);
        expect(calls.existsSync).toBe(2);
        expect(total).toBe(3);
    });

    test("does NOT count an ES named import, because the binding is captured at import time", async () => {
        const { calls, total } = await withFsCounter(async () => {
            namedStatSync(DIR);
        });

        // The documented floor: a module written with `import { statSync }` is invisible here.
        expect(calls.statSync).toBeUndefined();
        expect(total).toBe(0);
    });

    test("counts the fs.promises variants under a promises. prefix", async () => {
        const { calls } = await withFsCounter(async () => {
            await fs.promises.stat(DIR);
            await fs.promises.readFile(FILE);
        });

        expect(calls["promises.stat"]).toBe(1);
        expect(calls["promises.readFile"]).toBe(1);
    });

    test("does NOT count Bun.file, which is native", async () => {
        const { result, total } = await withFsCounter(async () => {
            return await Bun.file(FILE).text();
        });

        expect(result.length).toBeGreaterThan(0);
        expect(total).toBe(0);
    });

    test("keeps properties hanging off a patched method, so realpathSync.native still works", async () => {
        const { result } = await withFsCounter(async () => {
            return fs.realpathSync.native(DIR);
        });

        expect(result).toContain("benchmark");
    });

    test("restores node:fs when the body throws", async () => {
        const beforeStat = fs.statSync;
        const beforePromisesStat = fs.promises.stat;

        await expect(
            withFsCounter(async () => {
                fs.statSync(DIR);
                throw new Error("boom");
            })
        ).rejects.toThrow("boom");

        expect(fs.statSync).toBe(beforeStat);
        expect(fs.promises.stat).toBe(beforePromisesStat);
    });
});
