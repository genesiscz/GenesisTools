import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { discoverVaults, resolveActiveVault } from "./discovery";

function fixture(vaults: Record<string, { path: string; ts: number; open?: boolean }>): string {
    const dir = mkdtempSync(join(tmpdir(), "obs-cfg-"));
    writeFileSync(join(dir, "obsidian.json"), SafeJSON.stringify({ vaults }));
    return dir;
}

describe("obsidian discovery", () => {
    it("reads vaults from OBSIDIAN_CONFIG_DIR/obsidian.json, filters to existing paths", () => {
        const real = mkdtempSync(join(tmpdir(), "vault-"));
        const cfg = fixture({ a: { path: real, ts: 1 }, gone: { path: "/no/such", ts: 2 } });
        const vaults = discoverVaults({ OBSIDIAN_CONFIG_DIR: cfg } as NodeJS.ProcessEnv);
        expect(vaults.map((v) => v.path)).toEqual([real]);
    });

    it("active = open===true, else max ts", () => {
        const v1 = mkdtempSync(join(tmpdir(), "v1-"));
        const v2 = mkdtempSync(join(tmpdir(), "v2-"));
        const cfg = fixture({ a: { path: v1, ts: 10 }, b: { path: v2, ts: 5, open: true } });
        expect(resolveActiveVault({ OBSIDIAN_CONFIG_DIR: cfg } as NodeJS.ProcessEnv)).toBe(v2);
    });

    it("falls back to max ts when none are open", () => {
        const v1 = mkdtempSync(join(tmpdir(), "v1-"));
        const v2 = mkdtempSync(join(tmpdir(), "v2-"));
        const cfg = fixture({ a: { path: v1, ts: 10 }, b: { path: v2, ts: 5 } });
        expect(resolveActiveVault({ OBSIDIAN_CONFIG_DIR: cfg } as NodeJS.ProcessEnv)).toBe(v1);
    });
});
