import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    DEFAULT_HOOKS_CONFIG,
    type GuardConfig,
    type HooksConfig,
    hooksConfigPath,
    loadHooksConfigForWrite,
    mergeStoredConfig,
} from "./config";
import { writeJsonFile } from "./write-json";

/** Where the guard this port replaces keeps its tuned overrides. */
export function legacyGuardConfigPath(): string {
    return join(homedir(), ".claude", "hooks", "bash-guard.config.json");
}

/** The legacy file's shape. Every field is optional, and a missing file is an empty config. */
export interface LegacyGuardConfig {
    default?: GuardConfig["default"];
    harnesses?: GuardConfig["harnesses"];
    models?: GuardConfig["models"];
    contextCapPerSession?: number;
    longCommand?: { lines?: number; chars?: number };
}

export function readLegacyGuardConfig(path = legacyGuardConfigPath()): LegacyGuardConfig {
    let text: string;

    try {
        text = readFileSync(path, "utf8");
    } catch (err) {
        // A machine that never ran the old guard has no file. That is the empty config the
        // interface promises, not an error; every other read failure still surfaces.
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            return {};
        }

        throw err;
    }

    const parsed = SafeJSON.parse(text);

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${path} is not a JSON object`);
    }

    return parsed as LegacyGuardConfig;
}

/**
 * Maps the legacy guard config onto `HooksConfig.guard`. Only the keys the legacy file
 * actually carries are taken; everything else keeps the shipped default, so an import can
 * never silently blank a setting the old file never spoke about.
 */
export function guardFromLegacy(legacy: LegacyGuardConfig): GuardConfig {
    const base = DEFAULT_HOOKS_CONFIG.guard;

    return {
        enabled: base.enabled,
        default: legacy.default ?? base.default,
        harnesses: legacy.harnesses ?? base.harnesses,
        models: legacy.models ?? base.models,
        contextCapPerSession: legacy.contextCapPerSession ?? base.contextCapPerSession,
        longCommand: {
            lines: legacy.longCommand?.lines ?? base.longCommand.lines,
            chars: legacy.longCommand?.chars ?? base.longCommand.chars,
        },
    };
}

/**
 * The config the hooks would run under after importing `legacy`, merged exactly as they load it.
 * The parity scripts compare the old guard against THIS, so a legacy override is compared with
 * itself rather than reported as a port bug.
 */
export function importedHooksConfig(legacy: LegacyGuardConfig): HooksConfig {
    return mergeStoredConfig({ guard: guardFromLegacy(legacy) });
}

export interface ImportResult {
    from: string;
    to: string;
    config: HooksConfig;
    written: boolean;
}

export function importGuardConfig(options: { from?: string; to?: string; write: boolean }): ImportResult {
    const from = options.from ?? legacyGuardConfigPath();
    const to = options.to ?? hooksConfigPath();
    // Built from the config in effect at `to`, not the defaults: the import owns `guard` and
    // nothing else, so a `shadow`, `diff` or `logCommands` the user already set survives it.
    // `guard.enabled` is not a legacy setting, so it carries over too: a user who turned the
    // guard off would otherwise have it switched back on by an import, without being told.
    const current = loadHooksConfigForWrite(to);
    const config: HooksConfig = {
        ...current,
        guard: { ...guardFromLegacy(readLegacyGuardConfig(from)), enabled: current.guard.enabled },
    };

    if (options.write) {
        // The default `to` is `~/.genesis-tools/agents/hooks.json`, and that directory may not
        // exist yet; the atomic writer creates it.
        writeJsonFile(to, config);
    }

    return { from, to, config, written: options.write };
}
