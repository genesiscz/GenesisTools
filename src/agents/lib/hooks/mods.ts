import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * The plugin of Claude Code mods in this repository's marketplace (`plugins/genesis-tools-mods/`). The
 * marketplace is a folder, so an installed copy is read from the checkout and an edit needs only
 * `/reload-plugins`, never a reinstall.
 */
export const MODS_PLUGIN = "genesis-tools-mods@genesis-tools";

export const MODS_SCOPES = ["user", "project", "local"] as const;
export type ModsScope = (typeof MODS_SCOPES)[number];

/** Each mod by the name `hooks mods enable|disable` takes, with the hooks-config keys that switch it. */
export const MOD_SWITCHES: Record<string, string[]> = {
    diff: ["mods.diff.fullDiff"],
    idleCompact: ["mods.idleCompact.enabled"],
    agentModel: ["mods.agentModel.enabled"],
    decisions: ["mods.decisions.enabled"],
    links: ["mods.links.enabled"],
    git: ["mods.git.enabled"],
    askRow: ["mods.askRow.enabled"],
    spinner: ["mods.spinner.enabled"],
    cacheBand: ["mods.cacheBand.enabled"],
    tmpUsage: ["mods.tmpUsage.enabled"],
    agentsBand: ["mods.agentsBand.enabled"],
    hooks: ["mods.hooks.tokens"],
    hooksDedupe: ["mods.hooks.dedupe"],
};

/** The keys of the named mods (`all` is every one), and the names that are no mod. */
export function modSwitchKeys(names: readonly string[]): { keys: string[]; unknown: string[] } {
    const picked = names.includes("all") ? Object.keys(MOD_SWITCHES) : names;
    const unknown = picked.filter((name) => !(name in MOD_SWITCHES));
    const keys = picked.flatMap((name) => MOD_SWITCHES[name] ?? []);

    return { keys: [...new Set(keys)], unknown };
}

export interface ModsPluginState {
    installed: boolean;
    enabled: boolean;
    scope?: string;
    version?: string;
    /** The folder Claude Code reads it from (a folder marketplace), when it says. */
    readFrom?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/** The mods plugin's row in `claude plugin list --json`, which is an array of installed plugins. */
export function modsPluginState(listJson: string): ModsPluginState {
    let rows: unknown;

    try {
        rows = SafeJSON.parse(listJson, { strict: true });
    } catch (err) {
        logger.debug({ err }, "claude plugin list --json did not parse");
        return { installed: false, enabled: false };
    }

    const row: unknown = Array.isArray(rows)
        ? rows.find((item: unknown) => isRecord(item) && item.id === MODS_PLUGIN)
        : undefined;

    if (!isRecord(row)) {
        return { installed: false, enabled: false };
    }

    const field = (key: string): unknown => row[key];
    const text = (key: string): string | undefined => {
        const value = field(key);
        return typeof value === "string" ? value : undefined;
    };

    return {
        installed: true,
        enabled: field("enabled") === true,
        scope: text("scope"),
        version: text("version"),
        readFrom: text("readFromFolder"),
    };
}

/** `<claude dir>/settings.json`: the user settings, where `CLAUDE_CONFIG_DIR` moves the claude dir. */
export function claudeUserSettingsPath(): string {
    return join(env.paths.getClaudeConfigDir() ?? join(homedir(), ".claude"), "settings.json");
}

/** The folder plugins name a session's own plugin folders by, in the process env or settings `env`. */
export const PLUGIN_DIRS_VAR = "CLAUDE_CODE_PLUGIN_DIRS";

const MODS_FOLDER_NAME = "genesis-tools-mods";

function settingsEnv(settings: unknown): Record<string, unknown> {
    const block = isRecord(settings) ? settings.env : undefined;

    return isRecord(block) ? block : {};
}

/** The folders `CLAUDE_CODE_PLUGIN_DIRS` names in a settings object's `env` block. */
export function pluginDirsOf(settings: unknown): string[] {
    const value = settingsEnv(settings)[PLUGIN_DIRS_VAR];

    return typeof value === "string" ? value.split(delimiter).filter((dir) => dir.length > 0) : [];
}

/** Whether the settings load a mods plugin folder (`mods watch`), hot-reloaded on every save. */
export function modsWatched(settings: unknown): boolean {
    return pluginDirsOf(settings).some((dir) => basename(dir.replace(/\/+$/, "")) === MODS_FOLDER_NAME);
}

/**
 * `modsWatched` of the user settings file: `false` when there is no file, `undefined` when it cannot be read or is
 * not JSON. `mods status` reports that as unknown instead of stopping at a malformed settings file.
 */
export function modsWatchState(settingsPath = claudeUserSettingsPath()): boolean | undefined {
    if (!existsSync(settingsPath)) {
        return false;
    }

    try {
        return modsWatched(SafeJSON.parse(readFileSync(settingsPath, "utf8")));
    } catch (err) {
        logger.debug({ err, settingsPath }, "Claude settings unreadable: hot reload is unknown");
        return undefined;
    }
}

/**
 * The settings with the mods folder added to (or, `on: false`, every mods folder taken out of)
 * `env.CLAUDE_CODE_PLUGIN_DIRS`. Every interactive session loads such a folder as a `--plugin-dir` and
 * watches it, so a save reloads the mod; an installed plugin is never watched, only re-read by
 * `/reload-plugins`. Other folders in the list and other env keys are kept; an emptied list is removed.
 */
export function withModsWatch(settings: unknown, folder: string, on: boolean): Record<string, unknown> {
    const base = isRecord(settings) ? { ...settings } : {};
    const env = { ...settingsEnv(settings) };
    const others = pluginDirsOf(settings).filter((dir) => basename(dir.replace(/\/+$/, "")) !== MODS_FOLDER_NAME);
    const dirs = on ? [...others, folder] : others;

    if (dirs.length > 0) {
        env[PLUGIN_DIRS_VAR] = dirs.join(delimiter);
    } else {
        delete env[PLUGIN_DIRS_VAR];
    }

    if (Object.keys(env).length > 0) {
        base.env = env;
    } else {
        delete base.env;
    }

    return base;
}

/**
 * The settings files that can turn the mods plugin on or off for this session, the strongest first: the project's
 * local and shared settings (`CLAUDE_PROJECT_DIR`, which Claude Code gives its hooks), then the user settings.
 */
export function modsSettingsPaths(projectDir = env.getProcessEnv().CLAUDE_PROJECT_DIR): string[] {
    const project = projectDir
        ? [join(projectDir, ".claude", "settings.local.json"), join(projectDir, ".claude", "settings.json")]
        : [];
    return [...project, claudeUserSettingsPath()];
}

/**
 * Whether the strongest settings file that names the mods plugin turns it off. A file that does not name it (a
 * `--plugin-dir` or watched load, a project install read from the user side) decides nothing.
 */
export function modsPluginDisabled(paths = modsSettingsPaths()): boolean {
    for (const path of paths) {
        let settings: unknown;

        try {
            settings = SafeJSON.parse(readFileSync(path, "utf8"));
        } catch (err) {
            logger.debug({ err, path }, "Claude settings unreadable: they decide nothing about the mods plugin");
            continue;
        }

        const enabled = isRecord(settings) ? settings.enabledPlugins : undefined;
        const value = isRecord(enabled) ? enabled[MODS_PLUGIN] : undefined;

        if (typeof value === "boolean") {
            return !value;
        }
    }

    return false;
}

export interface ClaudePluginRun {
    ok: boolean;
    stdout: string;
    stderr: string;
}

/** `claude plugin <args>`, waited for; the caller reads `ok` and the output. */
export function claudePlugin(args: string[]): ClaudePluginRun {
    const command = ["claude", "plugin", ...args];
    logger.debug({ command }, "Running the Claude Code plugin command");
    const run = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });

    return { ok: run.exitCode === 0, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}
