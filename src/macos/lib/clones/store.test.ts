import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
    addWatchedDirs,
    type ClonesConfig,
    loadClonesConfig,
    removeWatchedDirs,
    setMinReal,
    setNodeModules,
    storage,
} from "@app/macos/lib/clones/store";

describe("clones store", () => {
    let snapshot: ClonesConfig | null;

    beforeAll(async () => {
        snapshot = await storage.getConfig<ClonesConfig>();
    });

    afterAll(async () => {
        if (snapshot) {
            await storage.setConfig(snapshot);
        } else {
            await storage.clearConfig();
        }
    });

    it("defaults to an empty config; add/remove watched dirs dedups & persists", async () => {
        const c0 = await loadClonesConfig();
        expect(Array.isArray(c0.watchedDirs)).toBe(true);

        const dir = process.cwd();
        const after = await addWatchedDirs([dir, dir]);
        expect(after.watchedDirs.filter((d) => d === dir).length).toBe(1);

        const removed = await removeWatchedDirs([dir]);
        expect(removed.watchedDirs.includes(dir)).toBe(false);
    });

    it("setMinReal / setNodeModules persist scalar settings", async () => {
        const a = await setMinReal(5_000_000);
        expect(a.minReal).toBe(5_000_000);
        const b = await setNodeModules(true);
        expect(b.nodeModules).toBe(true);
    });
});
