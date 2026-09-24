import { SafeJSON } from "@genesiscz/utils/json";
import { ruleById } from "@genesiscz/utils/shell/rules";
import {
    DEFAULT_HOOKS_CONFIG,
    type HarnessName,
    type HookOutcome,
    type HooksConfig,
    hooksConfigPath,
    isCount,
    isMegabytes,
    loadHooksConfigForWrite,
} from "./config";
import { writeJsonFile } from "./write-json";

const OUTCOMES: readonly HookOutcome[] = ["allow", "context", "warn", "block"];
const HARNESSES: readonly HarnessName[] = ["claude", "codex", "grok"];
const NUMERIC_DIFF = [
    "maxFiles",
    "maxLinesPerFile",
    "maxMessageBytes",
    "maxCaptureMB",
    "maxCaptureFileMB",
    "maxNamedPathMB",
] as const;

export const SETTABLE_KEYS = [
    "shadow",
    "logCommands",
    "enabled",
    "diff.enabled",
    "diff.maxFiles",
    "diff.maxLinesPerFile",
    "diff.maxMessageBytes",
    "diff.maxCaptureMB",
    "diff.maxCaptureFileMB",
    "diff.maxNamedPathMB",
    "diff.harnesses.<claude|codex|grok>.<enabled|maxFiles|…>",
    "maxLogMB",
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

/** An MB cap: any positive number, because `0.256` is a valid per-file ceiling. */
function asMegabytes(key: string, value: string): number {
    const parsed = Number(value);

    if (value.trim() === "" || !isMegabytes(parsed)) {
        throw new Error(`${key} takes a number of MB greater than 0, not ${SafeJSON.stringify(value)}`);
    }

    return parsed;
}

const MEGABYTE_DIFF: ReadonlySet<string> = new Set(["maxCaptureMB", "maxCaptureFileMB", "maxNamedPathMB"]);

/** One numeric diff field, range-checked by what it measures. */
function asDiffNumber(field: string, key: string, value: string): number {
    return MEGABYTE_DIFF.has(field) ? asMegabytes(key, value) : asCount(key, value);
}

function asOutcome(key: string, value: string): HookOutcome {
    if ((OUTCOMES as readonly string[]).includes(value)) {
        return value as HookOutcome;
    }

    throw new Error(`${key} takes one of ${OUTCOMES.join(", ")}, not ${SafeJSON.stringify(value)}`);
}

/**
 * One field of one harness's diff override, for example `diff.harnesses.grok.enabled`.
 *
 * It is a narrow door on purpose: `enabled` plus the numeric caps. Those are the settings a
 * harness's own display makes wrong, and every other field is shared for a reason.
 */
function withHarnessDiff(next: HooksConfig, key: string, value: string, harness: string, field: string): HooksConfig {
    if (!(HARNESSES as readonly string[]).includes(harness)) {
        throw new Error(`no such harness: ${harness}`);
    }

    const held = next.diff.harnesses[harness as HarnessName] ?? {};

    if (field === "enabled") {
        next.diff.harnesses[harness as HarnessName] = { ...held, enabled: asBoolean(key, value) };
        return next;
    }

    const numeric = NUMERIC_DIFF.find((candidate) => candidate === field);

    if (numeric) {
        next.diff.harnesses[harness as HarnessName] = { ...held, [numeric]: asDiffNumber(numeric, key, value) };
        return next;
    }

    throw new Error(`cannot set ${field} per harness. Settable: enabled, ${NUMERIC_DIFF.join(", ")}`);
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
        // `harnesses` is cloned too: `withHarnessDiff` replaces whole entries, and a shallow
        // `diff` spread would have it writing into the config it was handed.
        diff: { ...config.diff, harnesses: { ...config.diff.harnesses } },
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

    const perHarnessDiff = /^diff\.harnesses\.([^.]+)\.(.+)$/.exec(key);

    if (perHarnessDiff?.[1] && perHarnessDiff[2]) {
        return withHarnessDiff(next, key, value, perHarnessDiff[1], perHarnessDiff[2]);
    }

    const diffKey = NUMERIC_DIFF.find((candidate) => `diff.${candidate}` === key);

    if (diffKey) {
        next.diff[diffKey] = asDiffNumber(diffKey, key, value);
        return next;
    }

    if (key === "guard.longCommand.lines" || key === "guard.longCommand.chars") {
        next.guard.longCommand[key.endsWith("lines") ? "lines" : "chars"] = asCount(key, value);
        return next;
    }

    if (key === "maxLogMB") {
        next.maxLogMB = asMegabytes(key, value);
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The parts of `value` that differ from `fallback`, or `undefined` when nothing does.
 *
 * 🛑 The stored file must hold OVERRIDES only. `applySetting` works on the fully resolved
 * config, so writing that verbatim froze every current default into the file: observed
 * 2026-09-22, one `diff.maxFiles` change pinned ten unrelated settings, and a later default
 * would never have reached that machine again.
 *
 * An array is compared whole. These are small literal lists, and a per-element merge would
 * make "the user cleared this list" indistinguishable from "the user did not touch it".
 */
export function changedOnly(value: unknown, fallback: unknown): unknown {
    if (Array.isArray(value) || Array.isArray(fallback)) {
        return SafeJSON.stringify(value) === SafeJSON.stringify(fallback) ? undefined : value;
    }

    if (isRecord(value) && isRecord(fallback)) {
        const out: Record<string, unknown> = {};

        for (const [inner, held] of Object.entries(value)) {
            const diff = changedOnly(held, fallback[inner]);

            if (diff !== undefined) {
                out[inner] = diff;
            }
        }

        return Object.keys(out).length > 0 ? out : undefined;
    }

    return value === fallback ? undefined : value;
}

export function setHooksConfig(key: string, value: string, options: { write: boolean; path?: string }): SetResult {
    const path = options.path ?? hooksConfigPath();
    // Read from the file this writes: loading the default path while writing `options.path`
    // replaced every other setting in that file with whatever the default file held.
    const config = applySetting(loadHooksConfigForWrite(path), key, value);

    if (options.write) {
        // Atomic, and OVERRIDES only: the resolved config written whole froze every current
        // default into the file (see `changedOnly`).
        writeJsonFile(path, changedOnly(config, DEFAULT_HOOKS_CONFIG) ?? {});
    }

    return { path, config, written: options.write };
}
