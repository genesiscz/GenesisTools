import { readFileSync } from "node:fs";
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
 * Whether the user settings load the mods plugin: enabled in `enabledPlugins` (`hooks mods install`) or
 * named in `env.CLAUDE_CODE_PLUGIN_DIRS` (`hooks mods watch`), in `<claude dir>/settings.json`. A file read, not `claude plugin list`: the diff hook asks on every Bash call.
 * A project or local install is not seen, and a session that has not run `/reload-plugins` since the install
 * does not draw yet.
 */
export function modsPluginEnabled(settingsPath = claudeUserSettingsPath()): boolean {
    try {
        const settings: unknown = SafeJSON.parse(readFileSync(settingsPath, "utf8"), { strict: true });
        const enabled = isRecord(settings) ? settings.enabledPlugins : undefined;

        return (isRecord(enabled) && enabled[MODS_PLUGIN] === true) || modsWatched(settings);
    } catch (err) {
        logger.debug({ err, settingsPath }, "Claude settings unreadable: the mods plugin counts as off");
        return false;
    }
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
