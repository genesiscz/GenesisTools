import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
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

/**
 * The shared config, `{}` when it does not exist, or `null` when it exists but cannot be read
 * as an object. A corrupt file must not read as an empty one: every writer would then replace
 * it with `{ obsidian: … }` and erase the other consumers' sections.
 */
function readPluginConfig(path: string): PluginConfig | null {
    if (!existsSync(path)) {
        return {};
    }

    try {
        const parsed: unknown = SafeJSON.parse(readFileSync(path, "utf8"));

        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            return parsed as PluginConfig;
        }

        logger.warn({ path }, "obsidian: the shared plugin config is not a JSON object; treating it as unreadable");
    } catch (err) {
        logger.warn({ path, err }, "obsidian: the shared plugin config does not parse; treating it as unreadable");
    }

    return null;
}

function readSection(path: string): ObsidianConfig | null {
    const section = readPluginConfig(path)?.obsidian;

    return typeof section === "object" && section !== null ? (section as ObsidianConfig) : null;
}

/** A dated archive name no earlier archive holds, so a second same-day move never replaces one. */
function freeArchivePath(path: string): string {
    const base = `${path}.migrated-${new Date().toISOString().slice(0, 10)}`;
    let candidate = base;

    for (let suffix = 2; existsSync(candidate); suffix += 1) {
        candidate = `${base}-${suffix}`;
    }

    return candidate;
}

/**
 * Move the standalone file into the shared config, once.
 *
 * Idempotent: a section already in the shared config wins and the old file is left alone. The
 * old file is renamed rather than deleted, so the move is one `mv` from being undone.
 */
function migrateOnce(pluginPath: string, legacyPath: string): void {
    // An unreadable shared config is not "no section yet": migrating into it would overwrite it.
    if (readPluginConfig(pluginPath) === null || readSection(pluginPath) !== null || !existsSync(legacyPath)) {
        return;
    }

    try {
        const legacy = SafeJSON.parse(readFileSync(legacyPath, "utf8")) as ObsidianConfig;

        if (!legacy?.vaultRoot) {
            return;
        }

        // Archive FIRST, write second, as the plugin-side migration does. The other order left
        // the section written beside an unarchived source when the rename failed, and later
        // runs saw the section and never retried. A failed write moves the source back.
        const archived = freeArchivePath(legacyPath);

        renameSync(legacyPath, archived);

        try {
            writeSection(pluginPath, { vaultRoot: legacy.vaultRoot });
        } catch (err) {
            renameSync(archived, legacyPath);
            throw err;
        }
    } catch (err) {
        // Both sides are left as they were: a half-migrated config is worse than an unmigrated one.
        logger.warn(
            { pluginPath, legacyPath, err },
            "obsidian: could not migrate the vault root, leaving both untouched"
        );
    }
}

/**
 * Merge one key into the shared config, leaving every other consumer's section untouched.
 * Refuses an unreadable file, and replaces it atomically so a concurrent reader never sees a
 * half-written one (which it would then treat as unreadable).
 */
function writeSection(path: string, value: ObsidianConfig): void {
    const config = readPluginConfig(path);

    if (config === null) {
        throw new Error(`refusing to overwrite unreadable ${path}; fix or move it aside first`);
    }

    config.obsidian = value;
    mkdirSync(dirname(path), { recursive: true });

    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;

    writeFileSync(tmp, `${SafeJSON.stringify(config, null, 2)}\n`);
    renameSync(tmp, path);
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
