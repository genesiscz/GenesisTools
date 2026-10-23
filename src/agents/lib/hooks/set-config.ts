import { SafeJSON } from "@genesiscz/utils/json";
import { SHELL_RULES } from "@genesiscz/utils/shell/rules";
import {
    DEFAULT_HOOKS_CONFIG,
    FILL_MODES,
    type HarnessName,
    HIGHLIGHT_MODES,
    HIGHLIGHTERS,
    type HookOutcome,
    type HooksConfig,
    hooksConfigPath,
    isCount,
    isMegabytes,
    loadHooksConfigForWrite,
    type ModsConfig,
    mergeMods,
    OTHERS_SUMMARIES,
} from "./config";
import { FULL_DIFF_MODES } from "./diff/full";
import { DIFF_THEMES, type DiffThemeName } from "./diff/theme";
import { writeHooksFile } from "./hooks-file";

const OUTCOMES: readonly HookOutcome[] = ["allow", "context", "warn", "block"];
const HARNESSES: readonly HarnessName[] = ["claude", "codex", "grok"];
const NUMERIC_DIFF = [
    "maxFiles",
    "maxLinesPerFile",
    "maxBlockLines",
    "maxMessageChars",
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
    "diff.maxBlockLines",
    "diff.maxMessageChars",
    "diff.maxCaptureMB",
    "diff.maxCaptureFileMB",
    "diff.maxNamedPathMB",
    "diff.othersSummary",
    "diff.theme",
    "diff.highlight",
    "diff.highlighter",
    "diff.fill",
    "diff.fillMax",
    "diff.commandLines",
    "diff.columns",
    "diff.fullDiff",
    "diff.replaceNative",
    "diff.showTempScratch",
    "unpushed.<enabled|maxCommits|maxAgeMinutes|remindEveryMinutes>",
    "diff.harnesses.<claude|codex|grok>.<enabled|maxFiles|…>",
    "maxLogMB",
    "guard.longCommand.lines",
    "guard.longCommand.chars",
    "guard.contextCapPerSession",
    "guard.customRules",
    "rules.<rule-id>",
    "harnesses.<claude|codex|grok>.<rule-id>",
    "decisions.stopHook",
    "decisions.maxBlocksPerSession",
    "decisions.harnesses",
    "decisions.harvest",
    "decisions.injectAnswers",
    "decisions.staleness.<warnAfterMinutes|alarmAfterMinutes|notify>",
    "agentsTalk.hint",
    "mods.diff.<fullDiff|collapseGitSync>",
    "mods.idleCompact.<enabled|minutes|minTokens>",
    "mods.agentModel.<enabled|format>",
    "mods.<decisions|links|git|askRow|spinner>.enabled",
    "mods.git.labels",
    "mods.cacheBand.<enabled|warnMinutes|others>",
    "mods.tmpUsage.<enabled|minutes>",
    "mods.agentsBand.<enabled|warnMinutes>",
    "mods.hooks.<tokens|dedupe>",
] as const;

/** The flat keys of before 2026-10-23, still taken; `mods.<feature>` alone means its `enabled`. */
const MOD_ALIASES: Record<string, string> = {
    "mods.fullDiff": "mods.diff.fullDiff",
    "mods.collapseGitSync": "mods.diff.collapseGitSync",
    "mods.idleCompactMinutes": "mods.idleCompact.minutes",
    "mods.idleCompactMinTokens": "mods.idleCompact.minTokens",
};

/** The highest whole number each numeric mods field takes, and the lowest when it is not 1. */
const MOD_NUMBER_LIMITS: Record<string, { max: number; min?: number; why: string }> = {
    "idleCompact.minutes": { max: 59, why: "at 60 the 1-hour prompt cache has expired" },
    "idleCompact.minTokens": { max: Number.MAX_SAFE_INTEGER, min: 0, why: "" },
    "cacheBand.warnMinutes": { max: 59, why: "the cache lives 60 minutes" },
    "tmpUsage.minutes": { max: 120, why: "a reading older than 2 hours says little" },
    "agentsBand.warnMinutes": { max: 24 * 60, why: "a day" },
};

function isFields(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One `mods.<feature>.<field>` key, checked against the type of the field's default. */
function withMods(mods: ModsConfig, key: string, value: string): ModsConfig {
    const path = MOD_ALIASES[key] ?? key;
    const [, feature = "", field = "enabled"] = path.split(".");
    const base = new Map<string, unknown>(Object.entries(DEFAULT_HOOKS_CONFIG.mods)).get(feature);
    const held = new Map<string, unknown>(Object.entries(mods)).get(feature);

    if (!isFields(base) || !isFields(held) || !(field in base)) {
        throw new Error(`Unknown mods key ${SafeJSON.stringify(key)}; see the mods.* keys in --help`);
    }

    const part = { ...held };
    const sample = base[field];

    if (typeof sample === "boolean") {
        part[field] = asBoolean(key, value);
    } else if (typeof sample === "number") {
        const limit = MOD_NUMBER_LIMITS[`${feature}.${field}`];
        const count = asCount(key, value, limit?.min ?? 1);

        if (limit && count > limit.max) {
            throw new Error(`${key} takes ${limit.min ?? 1} to ${limit.max}: ${limit.why}`);
        }

        part[field] = count;
    } else if (feature === "git" && field === "labels") {
        if (value !== "full" && value !== "minimal") {
            throw new Error(`${key} takes full or minimal, not ${SafeJSON.stringify(value)}`);
        }

        part[field] = value;
    } else if (feature === "agentModel" && field === "format") {
        if (value !== "label" && value !== "short") {
            throw new Error(`${key} takes label or short, not ${SafeJSON.stringify(value)}`);
        }

        part[field] = value;
    }

    return mergeMods({ ...mods, [feature]: part });
}

/** One `decisions.*` key. The stop hook takes off|warn|block; `harnesses` a comma list. */
function withDecisions(next: HooksConfig, key: string, value: string): HooksConfig {
    const decisions = { ...next.decisions, staleness: { ...next.decisions.staleness } };
    next.decisions = decisions;

    switch (key) {
        case "decisions.stopHook": {
            if (value !== "off" && value !== "warn" && value !== "block") {
                throw new Error(`${key} takes off, warn or block, not ${SafeJSON.stringify(value)}`);
            }

            decisions.stopHook = value;
            return next;
        }
        case "decisions.maxBlocksPerSession":
            decisions.maxBlocksPerSession = asCount(key, value, 0);
            return next;
        case "decisions.harnesses": {
            const names = value
                .split(",")
                .map((name) => name.trim())
                .filter(Boolean);
            const unknown = names.filter((name) => !(HARNESSES as readonly string[]).includes(name));

            if (unknown.length > 0) {
                throw new Error(`no such harness: ${unknown.join(", ")}`);
            }

            decisions.harnesses = names as HarnessName[];
            return next;
        }
        case "decisions.harvest":
            decisions.harvest = asBoolean(key, value);
            return next;
        case "decisions.injectAnswers":
            decisions.injectAnswers = asBoolean(key, value);
            return next;
        case "decisions.staleness.warnAfterMinutes":
        case "decisions.staleness.alarmAfterMinutes":
            decisions.staleness[key.endsWith("warnAfterMinutes") ? "warnAfterMinutes" : "alarmAfterMinutes"] = asCount(
                key,
                value
            );
            return next;
        case "decisions.staleness.notify":
            decisions.staleness.notify = asBoolean(key, value);
            return next;
        default:
            throw new Error(`unknown key: ${key}. Settable: ${SETTABLE_KEYS.join(", ")}`);
    }
}

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

    if (field === "theme") {
        next.diff.harnesses[harness as HarnessName] = { ...held, theme: asTheme(key, value) };
        return next;
    }

    if (field === "columns") {
        next.diff.harnesses[harness as HarnessName] = { ...held, columns: asColumns(key, value) };
        return next;
    }

    throw new Error(`cannot set ${field} per harness. Settable: enabled, theme, columns, ${NUMERIC_DIFF.join(", ")}`);
}

function asTheme(key: string, value: string): DiffThemeName {
    const theme = DIFF_THEMES.find((candidate) => candidate === value);

    if (!theme) {
        throw new Error(`${key} takes ${DIFF_THEMES.join(", ")}, not ${SafeJSON.stringify(value)}`);
    }

    return theme;
}

function asColumns(key: string, value: string): number | "auto" {
    if (value === "auto") {
        return value;
    }

    const columns = Number(value);

    if (!isCount(columns, 0)) {
        throw new Error(
            `${key} takes auto or a whole number of columns (0 = no fill), not ${SafeJSON.stringify(value)}`
        );
    }

    return columns;
}

/** The ids a rule key may name: the built-in rules, plus the custom ones when the caller loaded them. */
export interface RuleIdOptions {
    ruleIds?: ReadonlySet<string>;
}

function knownRuleIds(options: RuleIdOptions): ReadonlySet<string> {
    return options.ruleIds ?? new Set(SHELL_RULES.map((rule) => rule.id));
}

/** Applies one dotted key to a config, validating the key and the value. Pure. */
export function applySetting(
    config: HooksConfig,
    key: string,
    value: string,
    options: RuleIdOptions = {}
): HooksConfig {
    const ruleIds = knownRuleIds(options);
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

    if (key === "diff.replaceNative") {
        next.diff.replaceNative = asBoolean(key, value);
        return next;
    }

    if (key === "diff.showTempScratch") {
        next.diff.showTempScratch = asBoolean(key, value);
        return next;
    }

    if (key.startsWith("unpushed.")) {
        const field = key.slice("unpushed.".length);

        if (field === "enabled") {
            next.unpushed = { ...config.unpushed, enabled: asBoolean(key, value) };
            return next;
        }

        if (field === "maxCommits" || field === "remindEveryMinutes") {
            next.unpushed = { ...config.unpushed, [field]: asCount(key, value, 0) };
            return next;
        }

        if (field === "maxAgeMinutes") {
            next.unpushed = { ...config.unpushed, maxAgeMinutes: asCount(key, value) };
            return next;
        }

        throw new Error(
            `unknown key: ${key}. Settable: unpushed.enabled, maxCommits, maxAgeMinutes, remindEveryMinutes`
        );
    }

    if (key === "diff.highlighter") {
        const name = HIGHLIGHTERS.find((candidate) => candidate === value);

        if (!name) {
            throw new Error(`${key} takes ${HIGHLIGHTERS.join(", ")}, not ${SafeJSON.stringify(value)}`);
        }

        next.diff.highlighter = name;
        return next;
    }

    if (key === "diff.fill") {
        const mode = FILL_MODES.find((candidate) => candidate === value);

        if (!mode) {
            throw new Error(`${key} takes ${FILL_MODES.join(", ")}, not ${SafeJSON.stringify(value)}`);
        }

        next.diff.fill = mode;
        return next;
    }

    if (key === "diff.highlight") {
        const mode = HIGHLIGHT_MODES.find((candidate) => candidate === value);

        if (!mode) {
            throw new Error(`${key} takes ${HIGHLIGHT_MODES.join(", ")}, not ${SafeJSON.stringify(value)}`);
        }

        next.diff.highlight = mode;
        return next;
    }

    if (key === "diff.theme") {
        next.diff.theme = asTheme(key, value);
        return next;
    }

    if (key === "diff.columns") {
        next.diff.columns = asColumns(key, value);
        return next;
    }

    if (key === "diff.fillMax") {
        next.diff.fillMax = asCount(key, value, 0);
        return next;
    }

    if (key === "diff.commandLines") {
        next.diff.commandLines = asCount(key, value, 0);
        return next;
    }

    if (key === "diff.fullDiff") {
        const mode = FULL_DIFF_MODES.find((candidate) => candidate === value);

        if (!mode) {
            throw new Error(`${key} takes ${FULL_DIFF_MODES.join(", ")}, not ${SafeJSON.stringify(value)}`);
        }

        next.diff.fullDiff = mode;
        return next;
    }

    if (key === "diff.othersSummary") {
        const mode = OTHERS_SUMMARIES.find((candidate) => candidate === value);

        if (!mode) {
            throw new Error(`${key} takes ${OTHERS_SUMMARIES.join(" or ")}, not ${SafeJSON.stringify(value)}`);
        }

        next.diff.othersSummary = mode;
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

    if (key.startsWith("decisions.")) {
        return withDecisions(next, key, value);
    }

    if (key === "agentsTalk.hint") {
        next.agentsTalk = { ...config.agentsTalk, hint: asBoolean(key, value) };
        return next;
    }

    if (key.startsWith("mods.")) {
        next.mods = withMods(config.mods, key, value);
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

    if (key === "guard.customRules") {
        // A comma list of files or folders; an empty value clears it.
        next.guard.customRules = value
            .split(",")
            .map((path) => path.trim())
            .filter(Boolean);
        return next;
    }

    const rule = /^rules\.(.+)$/.exec(key);

    if (rule?.[1]) {
        if (!ruleIds.has(rule[1])) {
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

        if (!ruleIds.has(ruleId)) {
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

export function setHooksConfig(
    key: string,
    value: string,
    options: { write: boolean; path?: string } & RuleIdOptions
): SetResult {
    const path = options.path ?? hooksConfigPath();
    // Read from the file this writes: loading the default path while writing `options.path`
    // replaced every other setting in that file with whatever the default file held.
    const config = applySetting(loadHooksConfigForWrite(path), key, value, options);

    if (options.write) {
        writeHooksFile({ path, config });
    }

    return { path, config, written: options.write };
}

/**
 * A rule is ON unless `guard.default` sets it to `allow`. A harness or model override can still
 * allow it for that harness or model alone; the picker leaves those alone and `rules list` shows them.
 */
export function ruleEnabled(config: HooksConfig, ruleId: string): boolean {
    return config.guard.default[ruleId] !== "allow";
}

export interface RuleSelection {
    enable: readonly string[];
    disable: readonly string[];
}

export interface RuleSelectionResult {
    config: HooksConfig;
    /** Rules this selection switched on or off; the others already were. */
    enabled: string[];
    disabled: string[];
}

/**
 * Switches rules on and off in `guard.default`. Off is `allow`. On REMOVES an `allow`, so the rule
 * returns to its own severity, and keeps any other outcome the user set (a `warn` stays a `warn`).
 * Pure; an unknown id, or an id in both lists, throws.
 */
export function applyRuleSelection(
    config: HooksConfig,
    selection: RuleSelection,
    options: RuleIdOptions = {}
): RuleSelectionResult {
    const ruleIds = knownRuleIds(options);
    const unknown = [...selection.enable, ...selection.disable].filter((id) => !ruleIds.has(id));

    if (unknown.length > 0) {
        throw new Error(`no such rule: ${unknown.join(", ")}`);
    }

    const both = selection.enable.filter((id) => selection.disable.includes(id));

    if (both.length > 0) {
        throw new Error(`a rule cannot be enabled and disabled at once: ${both.join(", ")}`);
    }

    const defaults = { ...config.guard.default };
    const enabled: string[] = [];
    const disabled: string[] = [];

    for (const id of selection.enable) {
        if (defaults[id] === "allow") {
            delete defaults[id];
            enabled.push(id);
        }
    }

    for (const id of selection.disable) {
        if (defaults[id] !== "allow") {
            defaults[id] = "allow";
            disabled.push(id);
        }
    }

    return { config: { ...config, guard: { ...config.guard, default: defaults } }, enabled, disabled };
}

export function setRuleSelection(
    selection: RuleSelection,
    options: { write: boolean; path?: string } & RuleIdOptions
): RuleSelectionResult & { path: string; written: boolean } {
    const path = options.path ?? hooksConfigPath();
    const result = applyRuleSelection(loadHooksConfigForWrite(path), selection, options);
    const changed = result.enabled.length > 0 || result.disabled.length > 0;

    if (options.write && changed) {
        writeHooksFile({ path, config: result.config });
    }

    return { ...result, path, written: options.write && changed };
}
