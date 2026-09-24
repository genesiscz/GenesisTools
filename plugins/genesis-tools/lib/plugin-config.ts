/**
 * The one config every genesis-tools plugin skill reads, and the one-time migrations
 * that fill it.
 *
 *   ~/.genesis-tools/plugins/config.json
 *     { "wrap-up": {…}, "research": {…}, "obsidian": {…} }
 *   ~/.genesis-tools/plugins/vault-registry.json
 *     { "entries": [ { projectDir, branch?, worktreeDir?, obsidianDir, docPath? }, … ] }
 *
 * Before this module the same facts lived in three unrelated places, each known to one
 * consumer: `~/.claude/handoff-registry.json` (wrap-up), `~/.genesis-tools/skills/research/
 * config.json` (research) and `~/.genesis-tools/obsidian/config.json` (the question tool and
 * the dev dashboard). Research therefore could not see the 46 project-to-vault mappings
 * wrap-up already had, and its own single `defaultPath` was overwritten by whichever project
 * answered its "where should research go?" prompt last.
 *
 * Every one of those paths is named in shipped code, so other installs can have files there
 * too. That is why the migrations live here and run from the plugin scripts themselves rather
 * than from a one-off script on one machine.
 *
 * Standalone by design: plugin skill scripts run under bare `bun <path>` with no access to
 * `@genesiscz/utils`, so this module imports nothing outside node builtins and Bun.
 */

import { chmod, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// env.tools.getHome() exactly: GENESIS_TOOLS_HOME (the sandbox root) ?? homedir(), with callers
// appending ".genesis-tools" themselves. It is what makes the migrations testable without
// touching the real home, and what keeps a sandboxed run out of the user's config.
// lint-rules-ignore: standalone script without access to @genesiscz/utils/env
export const toolsHome = (): string => process.env.GENESIS_TOOLS_HOME?.trim() || homedir();

export const PLUGINS_DIR = join(toolsHome(), ".genesis-tools", "plugins");
export const PLUGIN_CONFIG_PATH = join(PLUGINS_DIR, "config.json");
export const VAULT_REGISTRY_PATH = join(PLUGINS_DIR, "vault-registry.json");

/** Where each section lived before the move. Named in shipped code, so other installs have them. */
export const LEGACY_PATHS = {
    registry: join(toolsHome(), ".claude", "handoff-registry.json"),
    research: join(toolsHome(), ".genesis-tools", "skills", "research", "config.json"),
    obsidian: join(toolsHome(), ".genesis-tools", "obsidian", "config.json"),
} as const;

export function expandHome(p: string): string {
    return p.startsWith("~/") ? join(toolsHome(), p.slice(2)) : p;
}

/**
 * Write via temp file + rename so an interrupted write cannot leave a truncated file.
 * Carries the destination's mode across, because rename() swaps in a new inode created under
 * the current umask and would silently widen a private 0600 file to 0644.
 */
export async function writeAtomic(path: string, body: string): Promise<void> {
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    const existed = await Bun.file(path).exists();

    try {
        await Bun.write(tmp, body);

        if (existed) {
            const { mode } = await stat(path);
            await chmod(tmp, mode & 0o777);
        }

        await rename(tmp, path);
    } catch (err) {
        await rm(tmp, { force: true });
        throw err;
    }
}

type Json = Record<string, unknown>;

async function readJson(path: string, label: string): Promise<Json | null> {
    const file = Bun.file(path);

    if (!(await file.exists())) {
        return null;
    }

    try {
        const parsed = JSON.parse(await file.text());

        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Json) : null;
    } catch (err) {
        // Returning null silently would make a corrupt file look like an absent one, which is
        // how a whole registry disappears and the caller falls back to a different target.
        console.error(`${label}: ignoring unreadable ${path}: ${String(err)}`);

        return null;
    }
}

/** The whole shared config, or `{}` when it does not exist yet. */
export async function readPluginConfig(label = "plugins"): Promise<Json> {
    return (await readJson(PLUGIN_CONFIG_PATH, label)) ?? {};
}

/** One plugin's section of the shared config, or `{}`. */
export async function pluginSection<T extends Json>(key: string, label = key): Promise<Partial<T>> {
    const section = (await readPluginConfig(label))[key];

    return typeof section === "object" && section !== null && !Array.isArray(section) ? (section as Partial<T>) : {};
}

/** `mkdir -p` for the directory holding a file the caller is about to write. */
export async function ensureDir(filePath: string): Promise<void> {
    await Bun.$`mkdir -p ${dirname(filePath)}`.quiet();
}

/**
 * Merge one section into the shared config, leaving every other plugin's section untouched.
 * Read-modify-write, so a section is never lost by a writer that only knows its own key.
 */
export async function writePluginSection(key: string, value: Json, label = key): Promise<void> {
    const existing = await readJson(PLUGIN_CONFIG_PATH, label);

    if (existing === null && (await Bun.file(PLUGIN_CONFIG_PATH).exists())) {
        // The file is there but unreadable. Writing `{ [key]: value }` over it would erase every
        // other plugin's section, which is the loss this read-modify-write exists to prevent.
        throw new Error(`${label}: refusing to overwrite unreadable ${PLUGIN_CONFIG_PATH}; fix or move it aside first`);
    }

    const config = existing ?? {};

    config[key] = value;
    await ensureDir(PLUGIN_CONFIG_PATH);
    await writeAtomic(PLUGIN_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

export type MigrationResult =
    | { migrated: true; from: string; to: string; archived: string }
    | { migrated: false; reason: "no-source" | "target-present" | "error"; from: string; to: string; error?: string };

/**
 * A dated archive name no earlier archive already holds. The date alone collided when a legacy
 * file came back and migrated again the same day, and `rename` replaced the first backup
 * silently, so a free `-2`, `-3`, … suffix is taken instead.
 */
async function stampedArchive(path: string): Promise<string> {
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const base = `${path}.migrated-${day}`;
    let candidate = base;

    for (let suffix = 2; await Bun.file(candidate).exists(); suffix += 1) {
        candidate = `${base}-${suffix}`;
    }

    return candidate;
}

/**
 * Move one legacy file into its new home, once.
 *
 * Idempotent in both directions: a present target wins and the source is left alone, and a
 * missing source is not an error. The source is RENAMED rather than deleted, so a migration
 * that turns out wrong is one `mv` from being undone. Any failure leaves both sides as they
 * were: a half-migrated config is worse than an unmigrated one.
 */
export async function migrateOnce({
    from,
    to,
    label,
    targetPresent,
    write,
}: {
    from: string;
    to: string;
    label: string;
    /** Has the destination already got this data? A present target is never overwritten. */
    targetPresent: () => Promise<boolean>;
    /** Persist the parsed legacy contents in their new home. */
    write: (legacy: Json) => Promise<void>;
}): Promise<MigrationResult> {
    try {
        if (await targetPresent()) {
            return { migrated: false, reason: "target-present", from, to };
        }

        const legacy = await readJson(from, label);

        if (legacy === null) {
            return { migrated: false, reason: "no-source", from, to };
        }

        // Archive FIRST, write second. The other order left a written target beside an
        // unarchived source whenever the rename failed, and the next run then saw the target as
        // present and never retried. The contents are already in memory, so a write that fails
        // after the rename is undone by renaming the source straight back.
        const archived = await stampedArchive(from);

        await rename(from, archived);

        try {
            await write(legacy);
        } catch (err) {
            try {
                await rename(archived, from);
            } catch (restoreErr) {
                console.error(`${label}: could not move ${archived} back to ${from}: ${String(restoreErr)}`);
            }

            throw err;
        }

        console.error(`${label}: migrated ${from} to ${to} (old file kept as ${archived})`);

        return { migrated: true, from, to, archived };
    } catch (err) {
        console.error(`${label}: could not migrate ${from} to ${to}, leaving both untouched: ${String(err)}`);

        return { migrated: false, reason: "error", from, to, error: String(err) };
    }
}
