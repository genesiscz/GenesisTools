import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { resolveActiveVault } from "./discovery";

export interface ObsidianConfig {
    vaultRoot: string | null;
}

/**
 * The vault root lives in the shared plugin config, under an `"obsidian"` key.
 *
 * It used to have a file of its own at `~/.genesis-tools/obsidian/config.json`, known only to
 * the `question` tool and the dev dashboard, while the plugin skills that write into the same
 * vault kept their paths somewhere else entirely. One file, one key per consumer.
 */
export function pluginConfigPath(): string {
    return join(env.tools.getHome(), ".genesis-tools", "plugins", "config.json");
}

/** Where the vault root lived before the move. Migrated once, on first read. */
export function obsidianConfigPath(): string {
    return join(env.tools.getHome(), ".genesis-tools", "obsidian", "config.json");
}

type PluginConfig = Record<string, unknown>;

function readPluginConfig(path: string): PluginConfig {
    if (!existsSync(path)) {
        return {};
    }

    try {
        const parsed = SafeJSON.parse(readFileSync(path, "utf8")) as PluginConfig;

        return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
        // A corrupt shared config must not read as an absent one: that would silently demote
        // every consumer to vault auto-discovery and write notes into a different vault.
        return {};
    }
}

function readSection(path: string): ObsidianConfig | null {
    const section = readPluginConfig(path).obsidian;

    return typeof section === "object" && section !== null ? (section as ObsidianConfig) : null;
}

/**
 * Move the standalone file into the shared config, once.
 *
 * Idempotent: a section already in the shared config wins and the old file is left alone. The
 * old file is renamed rather than deleted, so the move is one `mv` from being undone.
 */
function migrateOnce(pluginPath: string, legacyPath: string): void {
    if (readSection(pluginPath) !== null || !existsSync(legacyPath)) {
        return;
    }

    try {
        const legacy = SafeJSON.parse(readFileSync(legacyPath, "utf8")) as ObsidianConfig;

        if (!legacy?.vaultRoot) {
            return;
        }

        writeSection(pluginPath, { vaultRoot: legacy.vaultRoot });
        renameSync(legacyPath, `${legacyPath}.migrated-${new Date().toISOString().slice(0, 10)}`);
    } catch {
        // Leave both sides untouched: a half-migrated config is worse than an unmigrated one.
    }
}

/** Merge one key into the shared config, leaving every other consumer's section untouched. */
function writeSection(path: string, value: ObsidianConfig): void {
    const config = readPluginConfig(path);

    config.obsidian = value;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${SafeJSON.stringify(config, null, 2)}\n`);
}

/** Resolution order: shared plugin config → legacy file (migrated) → obsidian.json discovery → null. */
export function resolveVaultRoot(path = pluginConfigPath(), legacyPath = obsidianConfigPath()): string | null {
    migrateOnce(path, legacyPath);

    const section = readSection(path);

    if (section?.vaultRoot && existsSync(section.vaultRoot)) {
        return section.vaultRoot;
    }

    return resolveActiveVault();
}

export function setVaultRoot(vaultRoot: string, path = pluginConfigPath()): void {
    writeSection(path, { vaultRoot });
}
