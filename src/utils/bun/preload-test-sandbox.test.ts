import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { Storage } from "@genesiscz/utils/storage/storage";

/**
 * Guards the sandbox itself. If this fails, tests are writing to the user's real
 * ~/.genesis-tools and the preload is either missing from bunfig.toml or loading
 * too late.
 */
describe("test sandbox preload", () => {
    test("GENESIS_TOOLS_HOME is set to a throwaway root", () => {
        const root = process.env.GENESIS_TOOLS_HOME;

        expect(root).toBeTruthy();
        expect(root).not.toBe(homedir());
    });

    test("Storage resolves outside the real home directory", () => {
        const base = new Storage("sandbox-probe").getBaseDir();

        // biome-ignore lint/plugin: asserts against the REAL home on purpose — the whole point is that the sandbox is elsewhere
        expect(base.startsWith(`${homedir()}/.genesis-tools`)).toBe(false);
        expect(base).toContain(".genesis-tools/sandbox-probe");
    });
});
