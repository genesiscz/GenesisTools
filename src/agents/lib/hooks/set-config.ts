import { SafeJSON } from "@genesiscz/utils/json";
import { ruleById } from "@genesiscz/utils/shell/rules";
import {
    type HarnessName,
    type HookOutcome,
    type HooksConfig,
    hooksConfigPath,
    isCount,
    loadHooksConfigForWrite,
} from "./config";
import { writeJsonFile } from "./write-json";

const OUTCOMES: readonly HookOutcome[] = ["allow", "context", "warn", "block"];
const HARNESSES: readonly HarnessName[] = ["claude", "codex", "grok"];

export const SETTABLE_KEYS = [
    "shadow",
    "logCommands",
    "enabled",
    "diff.enabled",
    "diff.maxFiles",
    "diff.maxLinesPerFile",
    "maxLogBytes",
    "guard.longCommand.lines",
    "guard.longCommand.chars",
    "guard.contextCapPerSession",
    "rules.<rule-id>",
    "harnesses.<claude|codex|grok>.<rule-id>",
] as const;

function asBoolean(key: string, value: string): boolean {
    if (value === "true" || value === "false") {
        return value === "true";
    }

    throw new Error(`${key} takes true or false, not ${SafeJSON.stringify(value)}`);
}

/** The same count domain the loader enforces, so `config set` cannot persist what a load would drop. */
function asCount(key: string, value: string, min = 1): number {
    const parsed = Number(value);

    if (value.trim() === "" || !isCount(parsed, min)) {
        throw new Error(`${key} takes a whole number of at least ${min}, not ${SafeJSON.stringify(value)}`);
    }

    return parsed;
}

function asOutcome(key: string, value: string): HookOutcome {
    if ((OUTCOMES as readonly string[]).includes(value)) {
        return value as HookOutcome;
    }

    throw new Error(`${key} takes one of ${OUTCOMES.join(", ")}, not ${SafeJSON.stringify(value)}`);
}

/** Applies one dotted key to a config, validating the key and the value. Pure. */
export function applySetting(config: HooksConfig, key: string, value: string): HooksConfig {
    const next: HooksConfig = {
        ...config,
        guard: {
            ...config.guard,
            default: { ...config.guard.default },
            harnesses: { ...config.guard.harnesses },
            longCommand: { ...config.guard.longCommand },
        },
        diff: { ...config.diff },
    };

    if (key === "shadow") {
        next.shadow = asBoolean(key, value);
        return next;
    }

    if (key === "logCommands") {
        if (value !== "shadow" && value !== "always" && value !== "never") {
            throw new Error(`${key} takes shadow, always or never, not ${SafeJSON.stringify(value)}`);
        }

        next.logCommands = value;
        return next;
    }

    if (key === "enabled" || key === "guard.enabled") {
        next.guard.enabled = asBoolean(key, value);
        return next;
    }

    if (key === "diff.enabled") {
        next.diff.enabled = asBoolean(key, value);
        return next;
    }

    if (key === "diff.maxFiles" || key === "diff.maxLinesPerFile") {
        next.diff[key === "diff.maxFiles" ? "maxFiles" : "maxLinesPerFile"] = asCount(key, value);
        return next;
    }

    if (key === "guard.longCommand.lines" || key === "guard.longCommand.chars") {
        next.guard.longCommand[key.endsWith("lines") ? "lines" : "chars"] = asCount(key, value);
        return next;
    }

    if (key === "maxLogBytes") {
        next.maxLogBytes = asCount(key, value);
        return next;
    }

    if (key === "guard.contextCapPerSession") {
        next.guard.contextCapPerSession = asCount(key, value, 0);
        return next;
    }

    const rule = /^rules\.(.+)$/.exec(key);

    if (rule?.[1]) {
        if (!ruleById(rule[1])) {
            throw new Error(`no such rule: ${rule[1]}`);
        }

        next.guard.default[rule[1]] = asOutcome(key, value);
        return next;
    }

    const perHarness = /^harnesses\.([^.]+)\.(.+)$/.exec(key);

    if (perHarness?.[1] && perHarness[2]) {
        const harness = perHarness[1];
        const ruleId = perHarness[2];

        if (!(HARNESSES as readonly string[]).includes(harness)) {
            throw new Error(`no such harness: ${harness}`);
        }

        if (!ruleById(ruleId)) {
            throw new Error(`no such rule: ${ruleId}`);
        }

        const existing = next.guard.harnesses[harness as HarnessName] ?? {};

        next.guard.harnesses[harness as HarnessName] = { ...existing, [ruleId]: asOutcome(key, value) };
        return next;
    }

    throw new Error(`unknown key: ${key}. Settable: ${SETTABLE_KEYS.join(", ")}`);
}

export interface SetResult {
    path: string;
    config: HooksConfig;
    written: boolean;
}

export function setHooksConfig(key: string, value: string, options: { write: boolean; path?: string }): SetResult {
    const path = options.path ?? hooksConfigPath();
    // Read from the file this writes: loading the default path while writing `options.path`
    // replaced every other setting in that file with whatever the default file held.
    const config = applySetting(loadHooksConfigForWrite(path), key, value);

    if (options.write) {
        writeJsonFile(path, config);
    }

    return { path, config, written: options.write };
}
