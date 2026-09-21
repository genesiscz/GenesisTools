import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { resolveVaultRoot, setVaultRoot } from "./config";

/**
 * The vault root moved out of its own file into the shared plugin config, so the migration has
 * to hold the same line the plugin-side ones do: move once, never overwrite, never half-write,
 * and never disturb another consumer's key.
 */

const dirs: string[] = [];

function sandbox(): { plugin: string; legacy: string; vault: string } {
    const root = mkdtempSync(join(tmpdir(), "gt-obsidian-"));

    dirs.push(root);
    const vault = join(root, "Vault");

    mkdirSync(vault, { recursive: true });

    return { plugin: join(root, "plugins/config.json"), legacy: join(root, "obsidian/config.json"), vault };
}

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function write(path: string, body: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof body === "string" ? body : SafeJSON.stringify(body, null, 2));
}

const read = (path: string) => SafeJSON.parse(readFileSync(path, "utf8"));
const archived = (path: string) => readdirSync(dirname(path)).filter((name) => name.includes(".migrated-"));

describe("vault root in the shared plugin config", () => {
    it("reads the obsidian key", () => {
        const { plugin, vault } = sandbox();

        write(plugin, { obsidian: { vaultRoot: vault } });

        expect(resolveVaultRoot(plugin, join(plugin, "../none.json"))).toBe(vault);
    });

    it("migrates the standalone file once and archives it", () => {
        const { plugin, legacy, vault } = sandbox();

        write(legacy, { vaultRoot: vault });

        expect(resolveVaultRoot(plugin, legacy)).toBe(vault);
        expect(read(plugin).obsidian).toEqual({ vaultRoot: vault });
        expect(existsSync(legacy)).toBe(false);
        expect(archived(legacy)).toHaveLength(1);

        // Second call must not migrate again, and must still answer.
        expect(resolveVaultRoot(plugin, legacy)).toBe(vault);
        expect(archived(legacy)).toHaveLength(1);
    });

    it("never overwrites an obsidian key that already exists", () => {
        const { plugin, legacy, vault } = sandbox();
        const other = join(vault, "..");

        write(plugin, { obsidian: { vaultRoot: vault } });
        write(legacy, { vaultRoot: other });
        resolveVaultRoot(plugin, legacy);

        expect(read(plugin).obsidian.vaultRoot).toBe(vault);
        expect(existsSync(legacy)).toBe(true);
    });

    it("leaves another plugin's key untouched when it writes", () => {
        const { plugin, vault } = sandbox();

        write(plugin, { "wrap-up": { vaultDir: "/keep" }, research: { defaultPath: "/keep/too" } });
        setVaultRoot(vault, plugin);

        const config = read(plugin);

        expect(config["wrap-up"]).toEqual({ vaultDir: "/keep" });
        expect(config.research).toEqual({ defaultPath: "/keep/too" });
        expect(config.obsidian).toEqual({ vaultRoot: vault });
    });

    it("falls back to discovery rather than a stale path when the configured vault is gone", () => {
        const { plugin, legacy } = sandbox();

        write(plugin, { obsidian: { vaultRoot: "/no/such/vault" } });

        // Whatever discovery answers, it must not be the path that no longer exists.
        expect(resolveVaultRoot(plugin, legacy)).not.toBe("/no/such/vault");
    });

    it("survives a corrupt shared config without throwing", () => {
        const { plugin, legacy } = sandbox();

        write(plugin, "{{{");

        expect(() => resolveVaultRoot(plugin, legacy)).not.toThrow();
    });
});
