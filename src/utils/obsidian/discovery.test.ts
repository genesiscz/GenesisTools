import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { configCandidates, discoverVaults, resolveActiveVault } from "./discovery";

function fixture(vaults: Record<string, { path: string; ts: number; open?: boolean }>): string {
    const dir = mkdtempSync(join(tmpdir(), "obs-cfg-"));
    writeFileSync(join(dir, "obsidian.json"), SafeJSON.stringify({ vaults }));
    return dir;
}

describe("obsidian discovery", () => {
    it("reads vaults from OBSIDIAN_CONFIG_DIR/obsidian.json, filters to existing paths", () => {
        const real = mkdtempSync(join(tmpdir(), "vault-"));
        const cfg = fixture({ a: { path: real, ts: 1 }, gone: { path: "/no/such", ts: 2 } });
        const vaults = discoverVaults({ OBSIDIAN_CONFIG_DIR: cfg });
        expect(vaults.map((v) => v.path)).toEqual([real]);
    });

    it("active = open===true, else max ts", () => {
        const v1 = mkdtempSync(join(tmpdir(), "v1-"));
        const v2 = mkdtempSync(join(tmpdir(), "v2-"));
        const cfg = fixture({ a: { path: v1, ts: 10 }, b: { path: v2, ts: 5, open: true } });
        expect(resolveActiveVault({ OBSIDIAN_CONFIG_DIR: cfg })).toBe(v2);
    });

    it("looks only at OBSIDIAN_CONFIG_DIR when it is set, never at the user's own config", () => {
        const home = mkdtempSync(join(tmpdir(), "obs-home-"));
        const vault = mkdtempSync(join(tmpdir(), "vault-"));
        const userConfig = configCandidates({ HOME: home })[0];
        mkdirSync(dirname(userConfig), { recursive: true });
        writeFileSync(userConfig, SafeJSON.stringify({ vaults: { a: { path: vault, ts: 1, open: true } } }));
        expect(resolveActiveVault({ HOME: home })).toBe(vault);

        const empty = mkdtempSync(join(tmpdir(), "obs-empty-"));
        expect(discoverVaults({ HOME: home, OBSIDIAN_CONFIG_DIR: empty })).toEqual([]);
        expect(resolveActiveVault({ HOME: home, OBSIDIAN_CONFIG_DIR: empty })).toBeNull();
    });

    it("falls back to max ts when none are open", () => {
        const v1 = mkdtempSync(join(tmpdir(), "v1-"));
        const v2 = mkdtempSync(join(tmpdir(), "v2-"));
        const cfg = fixture({ a: { path: v1, ts: 10 }, b: { path: v2, ts: 5 } });
        expect(resolveActiveVault({ OBSIDIAN_CONFIG_DIR: cfg })).toBe(v1);
    });
});
