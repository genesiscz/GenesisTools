import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { getProfilingConfig, setProfilingConfig } from "@genesiscz/utils/GenesisTools";
import { SafeJSON } from "@genesiscz/utils/json";
import { isInside, realGenesisToolsRoot, rmTestPath } from "@genesiscz/utils/storage/real-home-guard";

describe("getProfilingConfig", () => {
    const home = env.tools.getHome();
    const configPath = join(home, ".genesis-tools", "GenesisTools", "config.json");

    /**
     * Same control as the profiling command suite (PR #343 review t12). This file
     * rmSync's and rewrites `configPath`, which is the developer's real config
     * whenever GENESIS_TOOLS_HOME is missing. `preload-test-sandbox.ts` sets it
     * for every test process; assert that here so a broken preload is visible.
     * The assertion alone is NOT the protection: `beforeEach` runs before every
     * test including this one, so the deletes are guarded at the call itself via
     * `rmTestPath`.
     */
    it("runs against a sandbox home, never the real store", () => {
        expect(isInside(realGenesisToolsRoot(), configPath)).toBe(false);
    });

    beforeEach(() => {
        rmTestPath(configPath);
    });

    afterEach(() => {
        rmTestPath(configPath);
    });

    it("returns enabled false when the GenesisTools config file is missing", () => {
        expect(existsSync(configPath)).toBe(false);
        expect(getProfilingConfig().enabled).toBe(false);
    });

    it("returns enabled true when profiling.enabled is true in the file", () => {
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, '{ "profiling": { "enabled": true } }\n');
        expect(getProfilingConfig().enabled).toBe(true);
    });

    it("keeps default sinks when the file only sets enabled", () => {
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, '{ "profiling": { "enabled": true } }\n');
        const cfg = getProfilingConfig();
        expect(cfg.stderr).toBe(false);
        expect(cfg.file).toBe(true);
        expect(cfg.scopes).toEqual([]);
        expect(cfg.detail).toBe("phases");
        expect(cfg.minDurationMs).toBe(0);
        expect(cfg.summaryOnExit).toBe(false);
        expect(cfg.filePath).toBeNull();
    });

    it("setProfilingConfig writes profiling without dropping sibling keys", async () => {
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, '{ "browser": "brave" }\n');
        await setProfilingConfig({ enabled: true, scopes: ["claude-history"] });
        const raw = SafeJSON.parse(await Bun.file(configPath).text()) as {
            browser?: string;
            profiling?: { enabled?: boolean; scopes?: string[] };
        };
        expect(raw.browser).toBe("brave");
        expect(raw.profiling?.enabled).toBe(true);
        expect(raw.profiling?.scopes).toEqual(["claude-history"]);
    });
});
