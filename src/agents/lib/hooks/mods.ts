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
