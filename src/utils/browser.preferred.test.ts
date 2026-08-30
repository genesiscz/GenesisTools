import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Browser } from "@genesiscz/utils/browser";
import { getGenesisToolsConfigPath, getGenesisToolsStorage } from "@genesiscz/utils/GenesisTools";
import { Storage } from "@genesiscz/utils/storage";
import { isInside, realGenesisToolsRoot } from "@genesiscz/utils/storage/real-home-guard";

describe("Browser preferred store", () => {
    // Two tests below WRITE the legacy "genesis-tools" store, and only the
    // current path was being cleaned — so a leftover `{"browser":"safari"}`
    // survived into any later test in the same process, where getPreferred()
    // falls back to it (PR #343 review t11). Clear both stores, both ways.
    const clearStores = (): void => {
        for (const path of [getGenesisToolsConfigPath(), new Storage("genesis-tools").getConfigPath()]) {
            // `rmSync` is a raw node:fs call, so `assertTestSafePath` cannot see
            // it. If the sandbox preload were missing or late these paths resolve
            // under the REAL home and this cleanup would delete the user's config
            // (PR #343 review t4 round 10). Check the boundary here, immediately
            // before the delete, rather than trusting the environment.
            if (isInside(realGenesisToolsRoot(), path)) {
                throw new Error(`Refusing to delete "${path}": that is the REAL ~/.genesis-tools, not a sandbox.`);
            }

            if (existsSync(path)) {
                rmSync(path);
            }
        }
    };

    beforeEach(clearStores);
    afterEach(clearStores);

    it("setPreferred writes browser into the GenesisTools config file", async () => {
        await Browser.setPreferred("brave");
        const stored = await getGenesisToolsStorage().getConfigValue<string>("browser");
        expect(stored).toBe("brave");
        expect(await Browser.getPreferred()).toBe("brave");
    });

    it("getPreferred still reads a leftover genesis-tools config file", async () => {
        const legacy = new Storage("genesis-tools");
        const path = legacy.getConfigPath();
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, '{ "browser": "safari" }\n');
        expect(await Browser.getPreferred()).toBe("safari");
    });

    it("clearing the preference clears the legacy store too", async () => {
        // PR #343 review t20: deleting only the current store left getPreferred()
        // falling back to the legacy value, so the system default was unreachable.
        const legacy = new Storage("genesis-tools");
        const legacyPath = legacy.getConfigPath();
        mkdirSync(dirname(legacyPath), { recursive: true });
        writeFileSync(legacyPath, '{ "browser": "safari" }\n');
        await Browser.setPreferred("brave");
        expect(await Browser.getPreferred()).toBe("brave");

        await Browser.setPreferred(undefined);
        expect(await Browser.getPreferred()).toBeUndefined();
    });
});
