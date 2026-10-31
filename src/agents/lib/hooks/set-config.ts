import { hooksConfigPath } from "@genesiscz/utils/agents/hooks/config-section";
import {
    HOOK_CONFIG_SECTIONS,
    HOOK_SECTION_NAMES,
    type HookSectionName,
    type HookSectionValues,
    type HookSetContext,
    type HooksConfig,
    loadHooksConfigForWrite,
    sectionValue,
    withSectionValue,
} from "./config";
import { writeHooksFile } from "./hooks-file";
import { type SubagentLinePlan, wireSubagentLine } from "./install";
import { BUILT_IN_RULES } from "./tool-rules";

/**
 * Every key `set` takes, in the order help lists them. Each section owns its keys (`HOOK_CONFIG_SECTIONS`); this list
 * only orders them as they always printed, and `config.test.ts` holds it equal to the sections' union.
 */
export const SETTABLE_KEYS: readonly string[] = [
    ...HOOK_CONFIG_SECTIONS.core.settable.slice(0, 2),
    HOOK_CONFIG_SECTIONS.guard.settable[0] ?? "",
    ...HOOK_CONFIG_SECTIONS.diff.settable.slice(0, -1),
    ...HOOK_CONFIG_SECTIONS.unpushed.settable,
    ...HOOK_CONFIG_SECTIONS.diff.settable.slice(-1),
    ...HOOK_CONFIG_SECTIONS.core.settable.slice(2),
    ...HOOK_CONFIG_SECTIONS.guard.settable.slice(1),
    ...HOOK_CONFIG_SECTIONS.decisions.settable,
    ...HOOK_CONFIG_SECTIONS.questions.settable,
    ...HOOK_CONFIG_SECTIONS.agentsTalk.settable,
    ...HOOK_CONFIG_SECTIONS.mods.settable,
];

/** The ids a rule key may name: the built-in rules, plus the custom ones when the caller loaded them. */
export interface RuleIdOptions {
    ruleIds?: ReadonlySet<string>;
}

function knownRuleIds(options: RuleIdOptions): ReadonlySet<string> {
    return options.ruleIds ?? new Set(BUILT_IN_RULES.map((rule) => rule.id));
}

function withSection<Name extends HookSectionName>(
    config: HooksConfig,
    name: Name,
    key: string,
    value: string,
    context: HookSetContext
): HooksConfig | null {
    const section = HOOK_CONFIG_SECTIONS[name];

    if (!section.owns(key)) {
        return null;
    }

    const next: HookSectionValues[Name] = section.set(sectionValue(config, name), key, value, context);
    return withSectionValue(config, name, next);
}

/** Applies one dotted key to a config, validating the key and the value. Pure. */
export function applySetting(
    config: HooksConfig,
    key: string,
    value: string,
    options: RuleIdOptions = {}
): HooksConfig {
    const context: HookSetContext = { ruleIds: knownRuleIds(options) };

    for (const name of HOOK_SECTION_NAMES) {
        const next = withSection(config, name, key, value, context);

        if (next) {
            return next;
        }
    }

    throw new Error(`unknown key: ${key}. Settable: ${SETTABLE_KEYS.join(", ")}`);
}

export interface SetResult {
    path: string;
    config: HooksConfig;
    written: boolean;
    subagentLine?: SubagentLinePlan;
}

export function setHooksConfig(
    key: string,
    value: string,
    options: {
        write: boolean;
        path?: string;
        subagentLine?: { dist?: string; settingsPath?: string; replace?: boolean };
    } & RuleIdOptions
): SetResult {
    const path = options.path ?? hooksConfigPath();
    // Read from the file this writes: loading the default path while writing `options.path`
    // replaced every other setting in that file with whatever the default file held.
    const config = applySetting(loadHooksConfigForWrite(path), key, value, options);

    if (options.write) {
        writeHooksFile({ path, config });
    }

    const subagentLine =
        key === "mods.agentRow" || key === "mods.agentRow.enabled"
            ? wireSubagentLine({
                  ...options.subagentLine,
                  on: config.mods.agentRow.enabled,
                  write: options.write,
              })
            : undefined;

    return { path, config, written: options.write, ...(subagentLine ? { subagentLine } : {}) };
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
