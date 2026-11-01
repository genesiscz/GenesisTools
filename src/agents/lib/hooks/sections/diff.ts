import {
    asBoolean,
    asCount,
    asMegabytes,
    boolOr,
    countOr,
    type HookConfigSection,
    isCount,
    isMegabytes,
    legacyMB,
    megabytesOr,
    storedPart,
} from "@genesiscz/utils/agents/hooks/config-section";
import { ACCOUNT_PROVIDER_ALIASES, byHarnessWhere, type SomeHarnesses } from "@genesiscz/utils/ai/providers/alias-list";
import { harnessHooks } from "@genesiscz/utils/ai/providers/harness-hooks";
import type { HarnessId } from "@genesiscz/utils/harness/types";
import { SafeJSON } from "@genesiscz/utils/json";
import pc from "picocolors";
import type { DiffConfig, DiffOverrides, HookDoctorFacts } from "../config";
import type { DiffCategory } from "../diff/classify";
import { FULL_DIFF_MODES } from "../diff/full";
import { DIFF_THEMES, type DiffThemeName } from "../diff/theme";

const DEFAULT_DIFF: DiffConfig = {
    enabled: true,
    maxFiles: 15,
    maxLinesPerFile: 30,
    maxBlockLines: 400,
    contextLines: 3,
    maxRoots: 4,
    untrackedExpansionCap: 200,
    // The reason for each cap is on its field in config.ts. The three byte caps bind a real copy; a clone
    // writes no data and is held to `clone.maxFileMB`, set by what the post phase can still diff and log.
    maxCaptureFiles: 400,
    maxCaptureMB: 8,
    maxCaptureFileMB: 0.256,
    clone: { maxFileMB: 2 },
    highlight: "256",
    highlighter: "hljs",
    fill: "block",
    fillMax: 72,
    theme: "claude",
    columns: "auto",
    fullDiff: "genesis",
    standDownWhenNative: true,
    replaceNative: true,
    watchNamedPaths: true,
    maxNamedPaths: 8,
    maxNamedPathMB: 2,
    namedPathsShowCreated: false,
    showTempScratch: true,
    dedupeAcrossSessions: true,
    othersSummary: "line",
    maxMessageChars: 9_900,
    commandLines: 3,
    categories: { source: true, formatting: true, log: false, generated: false },
    // 🛑 OFF where the harness cannot show a diff (`rendersAnsiDiffs`; Grok, observed 2026-09-22, the reason is in
    // its driver's hooks part). The capture is skipped too, so such a session pays nothing for a render.
    harnesses: byHarnessWhere((id) => (harnessHooks(id).rendersAnsiDiffs ? undefined : { enabled: false })),
};

/**
 * Every field checked on its own. A hand-edited `"maxFiles": "3"` or `"enabled": "false"` used
 * to flow straight through a spread: the string compared oddly against numbers, and the
 * non-empty string `"false"` read as on.
 */
function mergeDiff(value: unknown, problems: string[]): DiffConfig {
    const base = DEFAULT_DIFF;
    const stored = storedPart<DiffConfig & { maxCaptureBytes: unknown }>(value);

    return {
        enabled: boolOr(stored?.enabled, base.enabled),
        maxFiles: countOr(problems, { field: "diff.maxFiles", value: stored?.maxFiles, fallback: base.maxFiles }),
        maxLinesPerFile: countOr(problems, {
            field: "diff.maxLinesPerFile",
            value: stored?.maxLinesPerFile,
            fallback: base.maxLinesPerFile,
        }),
        maxBlockLines: countOr(problems, {
            field: "diff.maxBlockLines",
            value: stored?.maxBlockLines,
            fallback: base.maxBlockLines,
        }),
        contextLines: countOr(problems, {
            field: "diff.contextLines",
            value: stored?.contextLines,
            fallback: base.contextLines,
            min: 0,
        }),
        maxRoots: countOr(problems, { field: "diff.maxRoots", value: stored?.maxRoots, fallback: base.maxRoots }),
        untrackedExpansionCap: countOr(problems, {
            field: "diff.untrackedExpansionCap",
            value: stored?.untrackedExpansionCap,
            fallback: base.untrackedExpansionCap,
        }),
        maxCaptureFiles: countOr(problems, {
            field: "diff.maxCaptureFiles",
            value: stored?.maxCaptureFiles,
            fallback: base.maxCaptureFiles,
        }),
        maxCaptureMB: megabytesOr(problems, {
            field: "diff.maxCaptureMB",
            value: stored?.maxCaptureMB,
            fallback: legacyMB(stored?.maxCaptureBytes) ?? base.maxCaptureMB,
        }),
        maxCaptureFileMB: megabytesOr(problems, {
            field: "diff.maxCaptureFileMB",
            value: stored?.maxCaptureFileMB,
            fallback: base.maxCaptureFileMB,
        }),
        clone: {
            maxFileMB: megabytesOr(problems, {
                field: "diff.clone.maxFileMB",
                value: stored?.clone?.maxFileMB,
                fallback: base.clone.maxFileMB,
            }),
        },
        highlight: highlightOr(stored?.highlight, base.highlight),
        highlighter: HIGHLIGHTERS.find((name) => name === stored?.highlighter) ?? base.highlighter,
        fill: FILL_MODES.find((mode) => mode === stored?.fill) ?? base.fill,
        fillMax: countOr(problems, { field: "diff.fillMax", value: stored?.fillMax, fallback: base.fillMax, min: 0 }),
        commandLines: countOr(problems, {
            field: "diff.commandLines",
            value: stored?.commandLines,
            fallback: base.commandLines,
            min: 0,
        }),
        theme: themeOr(stored?.theme, base.theme),
        columns: columnsOr(stored?.columns, base.columns),
        fullDiff: FULL_DIFF_MODES.find((mode) => mode === stored?.fullDiff) ?? base.fullDiff,
        standDownWhenNative: boolOr(stored?.standDownWhenNative, base.standDownWhenNative),
        watchNamedPaths: boolOr(stored?.watchNamedPaths, base.watchNamedPaths),
        maxNamedPaths: countOr(problems, {
            field: "diff.maxNamedPaths",
            value: stored?.maxNamedPaths,
            fallback: base.maxNamedPaths,
        }),
        maxNamedPathMB: megabytesOr(problems, {
            field: "diff.maxNamedPathMB",
            value: stored?.maxNamedPathMB,
            fallback: base.maxNamedPathMB,
        }),
        namedPathsShowCreated: boolOr(stored?.namedPathsShowCreated, base.namedPathsShowCreated),
        showTempScratch: boolOr(stored?.showTempScratch, base.showTempScratch),
        dedupeAcrossSessions: boolOr(stored?.dedupeAcrossSessions, base.dedupeAcrossSessions),
        replaceNative: boolOr(stored?.replaceNative, base.replaceNative),
        othersSummary: othersSummaryOr(stored?.othersSummary, base.othersSummary),
        maxMessageChars: countOr(problems, {
            field: "diff.maxMessageChars",
            value: stored?.maxMessageChars,
            fallback: base.maxMessageChars,
        }),
        // Merged FIELD BY FIELD for the same reason `longCommand` is: a hand-edited `hooks.json`
        // that turns one category on would otherwise blank every other one, and `undefined`
        // reads as "hidden".
        categories: {
            source: boolOr(stored?.categories?.source, base.categories.source),
            formatting: boolOr(stored?.categories?.formatting, base.categories.formatting),
            log: boolOr(stored?.categories?.log, base.categories.log),
            generated: boolOr(stored?.categories?.generated, base.categories.generated),
        },
        // Same field-by-field reason, one level deeper: a stored override for Codex must not
        // delete the shipped Grok one, which is what turns the diff off there.
        harnesses: mergedHarnesses(stored?.harnesses, problems),
    };
}

export const HIGHLIGHTERS = ["hljs", "bat"] as const;
export type Highlighter = (typeof HIGHLIGHTERS)[number];

export const FILL_MODES = ["block", "terminal", "none"] as const;
export type FillMode = (typeof FILL_MODES)[number];

export const HIGHLIGHT_MODES = ["256", "truecolor", "none"] as const;
export type HighlightMode = (typeof HIGHLIGHT_MODES)[number];

/** A stored highlight mode; `bat`, the old name of the only colour mode, reads as `truecolor`. */
export function highlightOr(value: unknown, fallback: HighlightMode): HighlightMode {
    if (value === "bat") {
        return "truecolor";
    }

    return HIGHLIGHT_MODES.find((mode) => mode === value) ?? fallback;
}

export function themeOr(value: unknown, fallback: DiffThemeName): DiffThemeName {
    return DIFF_THEMES.find((theme) => theme === value) ?? fallback;
}

/** `auto`, or a whole number of columns (0 = no fill); anything else falls back. */
export function columnsOr(value: unknown, fallback: DiffConfig["columns"]): DiffConfig["columns"] {
    return value === "auto" || isCount(value, 0) ? value : fallback;
}

export const OTHERS_SUMMARIES: readonly DiffConfig["othersSummary"][] = ["line", "hidden"];

function othersSummaryOr(value: unknown, fallback: DiffConfig["othersSummary"]): DiffConfig["othersSummary"] {
    return OTHERS_SUMMARIES.find((mode) => mode === value) ?? fallback;
}

/** One entry per harness, each merged over the shipped one rather than replacing it. */
function mergedHarnesses(
    stored: SomeHarnesses<DiffOverrides> | undefined,
    problems: string[]
): SomeHarnesses<DiffOverrides> {
    const merged: SomeHarnesses<DiffOverrides> = { ...DEFAULT_DIFF.harnesses };

    for (const harness of ACCOUNT_PROVIDER_ALIASES) {
        const override = stored?.[harness];

        if (typeof override === "object" && override !== null) {
            merged[harness] = {
                ...merged[harness],
                ...checkedOverride(override, `diff.harnesses.${harness}`, problems),
            };
        }
    }

    return merged;
}

const OVERRIDE_COUNTS = [
    "maxFiles",
    "maxLinesPerFile",
    "maxBlockLines",
    "maxRoots",
    "untrackedExpansionCap",
    "maxCaptureFiles",
    "maxNamedPaths",
    "maxMessageChars",
] as const;

const OVERRIDE_MEGABYTES = ["maxCaptureMB", "maxCaptureFileMB", "maxNamedPathMB"] as const;

const OVERRIDE_BOOLEANS = [
    "enabled",
    "standDownWhenNative",
    "watchNamedPaths",
    "namedPathsShowCreated",
    "showTempScratch",
    "dedupeAcrossSessions",
    "replaceNative",
] as const;

/**
 * The fields of one stored harness override that have the right type. A spread let a hand-edited
 * `"enabled": "true"` through, and the non-empty string read as on, which is the defect
 * `mergeDiff` closes for the shared block. A field of the wrong type is dropped, so it falls
 * through to the shared value. A dropped number is reported, so `hooks doctor` names it.
 */
function checkedOverride(stored: DiffOverrides, path: string, problems: string[]): DiffOverrides {
    const checked: DiffOverrides = {};

    // The same range checks `mergeDiff` applies to the shared block: a count is a whole number
    // of at least 1 (context lines may be 0), and an MB cap is a positive number.
    for (const key of OVERRIDE_COUNTS) {
        const value: unknown = stored[key];

        if (isCount(value, 1)) {
            checked[key] = value;
        } else if (value !== undefined) {
            problems.push(
                `${path}.${key} is ${SafeJSON.stringify(value)}, not a whole number of at least 1; ignoring it`
            );
        }
    }

    const contextLines: unknown = stored.contextLines;

    if (isCount(contextLines, 0)) {
        checked.contextLines = contextLines;
    } else if (contextLines !== undefined) {
        problems.push(
            `${path}.contextLines is ${SafeJSON.stringify(contextLines)}, not a whole number of at least 0; ignoring it`
        );
    }

    for (const key of OVERRIDE_MEGABYTES) {
        const value: unknown = stored[key];

        if (isMegabytes(value)) {
            checked[key] = value;
        } else if (value !== undefined) {
            problems.push(`${path}.${key} is ${SafeJSON.stringify(value)}, not a positive number; ignoring it`);
        }
    }

    for (const key of OVERRIDE_BOOLEANS) {
        const value: unknown = stored[key];

        if (typeof value === "boolean") {
            checked[key] = value;
        }
    }

    const fill = FILL_MODES.find((mode) => mode === stored.fill);

    if (fill) {
        checked.fill = fill;
    }

    const highlight: unknown = stored.highlight;

    if (highlight === "bat" || HIGHLIGHT_MODES.some((mode) => mode === highlight)) {
        checked.highlight = highlightOr(highlight, "256");
    }

    if (stored.othersSummary === "line" || stored.othersSummary === "hidden") {
        checked.othersSummary = stored.othersSummary;
    }

    if (DIFF_THEMES.some((theme) => theme === stored.theme)) {
        checked.theme = stored.theme;
    }

    if (stored.columns === "auto" || isCount(stored.columns, 0)) {
        checked.columns = stored.columns;
    }

    if (FULL_DIFF_MODES.some((mode) => mode === stored.fullDiff)) {
        checked.fullDiff = stored.fullDiff;
    }

    const categories: Partial<Record<DiffCategory, boolean>> = {};

    for (const category of ["source", "formatting", "log", "generated"] as const) {
        const value: unknown = stored.categories?.[category];

        if (typeof value === "boolean") {
            categories[category] = value;
        }
    }

    if (Object.keys(categories).length > 0) {
        checked.categories = categories;
    }

    return checked;
}

const NUMERIC_DIFF = [
    "maxFiles",
    "maxLinesPerFile",
    "maxBlockLines",
    "maxMessageChars",
    "maxCaptureMB",
    "maxCaptureFileMB",
    "maxNamedPathMB",
] as const;

const MEGABYTE_DIFF: ReadonlySet<string> = new Set(["maxCaptureMB", "maxCaptureFileMB", "maxNamedPathMB"]);

/** One numeric diff field, range-checked by what it measures. */
function asDiffNumber(field: string, key: string, value: string): number {
    return MEGABYTE_DIFF.has(field) ? asMegabytes(key, value) : asCount(key, value);
}

/**
 * One field of one harness's diff override, for example `diff.harnesses.grok.enabled`.
 *
 * It is a narrow door on purpose: `enabled` plus the numeric caps. Those are the settings a
 * harness's own display makes wrong, and every other field is shared for a reason.
 */
function withHarnessDiff(diff: DiffConfig, key: string, value: string, harness: string, field: string): DiffConfig {
    const id = ACCOUNT_PROVIDER_ALIASES.find((name) => name === harness);

    if (!id) {
        throw new Error(`no such harness: ${harness}`);
    }

    const held = diff.harnesses[id] ?? {};

    if (field === "enabled") {
        diff.harnesses[id] = { ...held, enabled: asBoolean(key, value) };
        return diff;
    }

    const numeric = NUMERIC_DIFF.find((candidate) => candidate === field);

    if (numeric) {
        diff.harnesses[id] = { ...held, [numeric]: asDiffNumber(numeric, key, value) };
        return diff;
    }

    if (field === "theme") {
        diff.harnesses[id] = { ...held, theme: asTheme(key, value) };
        return diff;
    }

    if (field === "columns") {
        diff.harnesses[id] = { ...held, columns: asColumns(key, value) };
        return diff;
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

/**
 * The diff settings in force for one harness.
 *
 * `categories` merges field by field for the same reason the stored config does: an override
 * that turns one kind on must not blank the other three.
 */
export function diffForHarness(diff: DiffConfig, harness: HarnessId | undefined): DiffConfig {
    const override = harness ? diff.harnesses[harness] : undefined;

    if (!override) {
        return diff;
    }

    return {
        ...diff,
        ...override,
        categories: { ...diff.categories, ...override.categories },
    };
}

/** The one-word settings and the choices each takes, in the order `set` checks them. */
const DIFF_CHOICES: Readonly<Record<string, { choices: readonly string[]; joiner: string }>> = {
    "diff.highlighter": { choices: HIGHLIGHTERS, joiner: ", " },
    "diff.fill": { choices: FILL_MODES, joiner: ", " },
    "diff.highlight": { choices: HIGHLIGHT_MODES, joiner: ", " },
    "diff.fullDiff": { choices: FULL_DIFF_MODES, joiner: ", " },
    "diff.othersSummary": { choices: OTHERS_SUMMARIES, joiner: " or " },
};
const DIFF_SWITCHES = ["diff.enabled", "diff.replaceNative", "diff.showTempScratch"] as const;
const DIFF_KEYS: ReadonlySet<string> = new Set([
    ...DIFF_SWITCHES,
    ...Object.keys(DIFF_CHOICES),
    "diff.theme",
    "diff.columns",
    "diff.fillMax",
    "diff.commandLines",
    "diff.clone.maxFileMB",
    ...NUMERIC_DIFF.map((field) => `diff.${field}`),
]);
const HARNESS_DIFF_KEY = /^diff\.harnesses\.([^.]+)\.(.+)$/;

/** The field of `diff` a `diff.<field>` key names, when it takes one of a fixed list of words. */
function choiceOf(key: string, value: string): string {
    const spec = DIFF_CHOICES[key];
    const choice = spec?.choices.find((candidate) => candidate === value);

    if (!spec || !choice) {
        throw new Error(`${key} takes ${spec?.choices.join(spec.joiner)}, not ${SafeJSON.stringify(value)}`);
    }

    return choice;
}

function set(current: DiffConfig, key: string, value: string): DiffConfig {
    // `harnesses` is cloned too: `withHarnessDiff` replaces whole entries, and a shallow spread would have it
    // writing into the config it was handed.
    const next: DiffConfig = { ...current, harnesses: { ...current.harnesses } };
    const perHarness = HARNESS_DIFF_KEY.exec(key);

    if (perHarness?.[1] && perHarness[2]) {
        return withHarnessDiff(next, key, value, perHarness[1], perHarness[2]);
    }

    switch (key) {
        case "diff.enabled":
        case "diff.replaceNative":
        case "diff.showTempScratch":
            next[
                key === "diff.enabled" ? "enabled" : key === "diff.replaceNative" ? "replaceNative" : "showTempScratch"
            ] = asBoolean(key, value);
            return next;
        case "diff.highlighter":
            next.highlighter = HIGHLIGHTERS.find((name) => name === choiceOf(key, value)) ?? next.highlighter;
            return next;
        case "diff.fill":
            next.fill = FILL_MODES.find((mode) => mode === choiceOf(key, value)) ?? next.fill;
            return next;
        case "diff.highlight":
            next.highlight = HIGHLIGHT_MODES.find((mode) => mode === choiceOf(key, value)) ?? next.highlight;
            return next;
        case "diff.fullDiff":
            next.fullDiff = FULL_DIFF_MODES.find((mode) => mode === choiceOf(key, value)) ?? next.fullDiff;
            return next;
        case "diff.othersSummary":
            next.othersSummary = OTHERS_SUMMARIES.find((mode) => mode === choiceOf(key, value)) ?? next.othersSummary;
            return next;
        case "diff.theme":
            next.theme = asTheme(key, value);
            return next;
        case "diff.columns":
            next.columns = asColumns(key, value);
            return next;
        case "diff.fillMax":
            next.fillMax = asCount(key, value, 0);
            return next;
        case "diff.commandLines":
            next.commandLines = asCount(key, value, 0);
            return next;
        case "diff.clone.maxFileMB":
            next.clone = { ...next.clone, maxFileMB: asMegabytes(key, value) };
            return next;
        default: {
            const field = NUMERIC_DIFF.find((candidate) => `diff.${candidate}` === key);

            if (!field) {
                throw new Error(`unknown diff key: ${key}`);
            }

            next[field] = asDiffNumber(field, key, value);
            return next;
        }
    }
}

/** The Bash diff's part of `hooks.json`: what it captures, how it renders, and the per-harness overrides. */
export const DIFF_HOOK_SECTION: HookConfigSection<DiffConfig, HookDoctorFacts> = {
    key: "diff",
    defaults: () => structuredClone(DEFAULT_DIFF),
    merge: mergeDiff,
    settable: [
        "diff.enabled",
        ...NUMERIC_DIFF.map((field) => `diff.${field}`),
        "diff.clone.maxFileMB",
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
        `diff.harnesses.<${ACCOUNT_PROVIDER_ALIASES.join("|")}>.<enabled|maxFiles|…>`,
    ],
    owns: (key) => DIFF_KEYS.has(key) || HARNESS_DIFF_KEY.test(key),
    set,
    // Always wired, also while `diff.enabled` is off: the same processes keep the session change log and sweep the
    // captures, and a switch back on needs no reinstall.
    entries: () => ["bash-pre", "diff-post", "diff-post-failure", "session-end"],
    doctor: (diff, facts) => [
        ["diff.enabled", String(diff.enabled)],
        ["diff.maxFiles", String(diff.maxFiles)],
        ["diff.standDownWhenNative", String(diff.standDownWhenNative)],
        ["native Bash diff", facts.nativeDiff],
        [
            "diff per harness",
            ACCOUNT_PROVIDER_ALIASES.map(
                (harness) => `${harness} ${diffForHarness(diff, harness).enabled ? "on" : pc.yellow("off")}`
            ).join(" · "),
        ],
    ],
};
