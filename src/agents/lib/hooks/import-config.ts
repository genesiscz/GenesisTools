import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { DEFAULT_HOOKS_CONFIG, type GuardConfig, type HooksConfig, hooksConfigPath } from "./config";

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
    const parsed = SafeJSON.parse(readFileSync(path, "utf8"));

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

export interface ImportResult {
    from: string;
    to: string;
    config: HooksConfig;
    written: boolean;
}

export function importGuardConfig(options: { from?: string; to?: string; write: boolean }): ImportResult {
    const from = options.from ?? legacyGuardConfigPath();
    const to = options.to ?? hooksConfigPath();
    const config: HooksConfig = {
        ...DEFAULT_HOOKS_CONFIG,
        guard: guardFromLegacy(readLegacyGuardConfig(from)),
    };

    if (options.write) {
        // The default `to` is `~/.genesis-tools/agents/hooks.json`, and that directory may
        // not exist yet. Without this the write threw ENOENT and the CLI reported it as
        // "Cannot read the legacy guard config", naming the wrong operation entirely.
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, `${SafeJSON.stringify(config, null, 2)}\n`);
    }

    return { from, to, config, written: options.write };
}
