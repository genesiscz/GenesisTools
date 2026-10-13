import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { aiDataDir } from "@genesiscz/utils/ai/config/paths";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { shellCommandLine } from "@genesiscz/utils/shell/quote";
import { isJsonObject } from "@genesiscz/utils/storage/atomic-file";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import type { StatuslineConfig } from "./types";

/** Synthetic session id for preview/configure so a diagnostic never writes a live session file. */
export const PREVIEW_SESSION_ID = "00000000-preview";

/**
 * Defaults reproduce the previous shell statusline plus the graft wrapper around it,
 * so a fresh install renders the same line the shell script did.
 */
export function defaultStatuslineConfig(): StatuslineConfig {
    return {
        showDelta: true,
        showSession: true,
        showAccount: true,
        showGit: true,
        showDirty: false,
        modelStyle: "id",
        graft: { enabled: true, shim: join(homedir(), ".claude", "helpers", "graft-statusline.cjs"), ttlMs: 10_000 },
        metricsPost: { enabled: false, url: "http://localhost:8765/statusline", timeoutMs: 300 },
        gitTtlMs: 5_000,
        extends: null,
        fallbackColumns: 80,
        previousCommand: null,
    };
}

export function statuslineConfigPath(): string {
    return aiDataDir("statusline", "config.json");
}

function isStatuslineConfigPatch(value: unknown): value is Partial<StatuslineConfig> {
    return isJsonObject(value);
}

/**
 * The saved fields, `{}` when there is no file. Throws, naming the path, when the file exists but is
 * not a JSON object: install and uninstall save what they load, and defaults saved over it would
 * erase `previousCommand`, the user's old statusline.
 */
function readSavedStatuslineConfig(path: string): Partial<StatuslineConfig> {
    let text: string;

    try {
        text = readFileSync(path, "utf8");
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return {};
        }

        throw error;
    }

    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(text, { unbox: true });
    } catch (error) {
        throw new Error(`Statusline config ${path} does not parse, so it was left untouched. Fix it, then retry.`, {
            cause: error,
        });
    }

    if (parsed === null) {
        return {};
    }

    if (!isStatuslineConfigPatch(parsed)) {
        throw new Error(
            `Statusline config ${path} is not a JSON object, so it was left untouched. Fix it, then retry.`
        );
    }

    return parsed;
}

/** For rendering and display: a config that cannot be read renders with the defaults. */
export async function loadStatuslineConfig(path = statuslineConfigPath()): Promise<StatuslineConfig> {
    try {
        return await loadStatuslineConfigForUpdate(path);
    } catch (error) {
        logger.warn({ err: error, path }, "statusline config unreadable, using defaults");
        return defaultStatuslineConfig();
    }
}

/** For a caller that saves what it loads (install, uninstall, configure): throws on a config that cannot be read. */
export async function loadStatuslineConfigForUpdate(path = statuslineConfigPath()): Promise<StatuslineConfig> {
    return mergeStatuslineConfig(defaultStatuslineConfig(), readSavedStatuslineConfig(path));
}

/**
 * Atomic, so a crash or a full disk cannot truncate `previousCommand`. Refuses, leaving the file as it
 * is, when the file on disk does not parse: the caller then holds defaults, not what the file says.
 */
export async function saveStatuslineConfig(config: StatuslineConfig, path = statuslineConfigPath()): Promise<void> {
    readSavedStatuslineConfig(path);
    atomicWriteFileSync(path, `${SafeJSON.stringify(config, { strict: true }, 2)}\n`);
    logger.debug({ path }, "statusline config saved");
}

export function mergeStatuslineConfig(base: StatuslineConfig, patch: Partial<StatuslineConfig>): StatuslineConfig {
    return {
        ...base,
        ...patch,
        graft: { ...base.graft, ...patch.graft },
        metricsPost: { ...base.metricsPost, ...patch.metricsPost },
        extends: patch.extends === undefined ? base.extends : patch.extends,
    };
}

/** Preview and configure must not write token deltas or POST the live payload. */
export function previewRenderConfig(config: StatuslineConfig): StatuslineConfig {
    return {
        ...config,
        showDelta: false,
        metricsPost: { ...config.metricsPost, enabled: false },
    };
}

/**
 * Keep the host's previous statusline command when we replace one that is not ours.
 * `install` persists this; the wizard must save the result, not the pre-install object.
 */
export function rememberPreviousCommand(
    config: StatuslineConfig,
    currentCommand: string | null,
    ours: boolean
): StatuslineConfig {
    if (ours) {
        return config;
    }

    return { ...config, previousCommand: currentCommand };
}

export function statuslineInstalledHotEntryPath(): string {
    return aiDataDir("statusline", "run.ts");
}

export function isStatuslineInstallCommand(command: string | null): boolean {
    return command !== null && (command.includes("statusline/run.ts") || command.includes("ai statusline run"));
}

export function formatStatuslineInstallCommand(opts: {
    host: "claude" | "codex" | "grok";
    viaTools: boolean;
    bunPath?: string;
    entryPath?: string;
}): string {
    if (opts.viaTools) {
        return `${toolCommand("ai statusline run")} --${opts.host}`;
    }

    return shellCommandLine([
        opts.bunPath ?? process.execPath,
        opts.entryPath ?? statuslineInstalledHotEntryPath(),
        `--${opts.host}`,
    ]);
}
