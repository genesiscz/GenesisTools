import { readFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { toolDataDir } from "@genesiscz/utils/storage/root";

/**
 * The hooks config file (`~/.genesis-tools/agents/hooks.json`) as the features that own a part of it see it. A hook
 * feature is a section: one top-level key, its defaults, how a stored value merges over them, and the `tools agents
 * hooks set` keys it takes. The feature's own folder implements it (the decisions section lives beside the decision
 * log, the questions section beside the dialog records), and `src/agents/lib/hooks/config.ts` lists the sections. A
 * tool that only needs its feature's settings reads its section here, without importing the agents tool.
 *
 * 🛑 Synchronous and light on purpose: hook entrypoints read the config before stdin on every tool call, and this
 * module imports only `SafeJSON` and the data-dir helper (no logger).
 */
/**
 * The hook entries an installer can wire, by what they run. Several features can need one entry (the Stop entry
 * serves the decision hub, the question nudge and the unpushed reminder); the installer wires each kind once.
 */
export const HOOK_ENTRY_KINDS = [
    "stop",
    "prompt",
    "bash-pre",
    "diff-post",
    "diff-post-failure",
    "session-end",
    "questions",
] as const;
export type HookEntryKind = (typeof HOOK_ENTRY_KINDS)[number];

/** An install that forces a feature's entries on or off (`installHooks({ decisions: true })`); absent: the config. */
export type HookInstallOverrides = Readonly<Partial<Record<string, boolean>>>;

/** One row of `tools agents hooks doctor`'s settings table: the setting, and its value as shown. */
export type HookDoctorRow = readonly [label: string, value: string];

/**
 * One hook feature's part of `hooks.json`, and everything the feature decides about it.
 *
 * - `Facts`: what its doctor rows may show besides its own value (the loaded rule set, whether a Stop hook is wired).
 * - `Context`: what its `set` needs besides the key and value (the rule ids a rule key may name).
 * A section that needs neither leaves them `unknown` and ignores the argument.
 */
export interface HookConfigSection<T, Facts = unknown, Context = unknown> {
    /** The section's top-level key in `hooks.json`; null for the keys that sit at the top level itself. */
    readonly key: string | null;
    defaults(): T;
    /**
     * The stored value (anything, a hand edit included) merged field by field over the defaults. A present value of
     * the wrong type falls back and is named in `problems`, which `hooks doctor` prints. A top-level section gets
     * the whole stored object.
     */
    merge(stored: unknown, problems: string[]): T;
    /** The keys `tools agents hooks set` takes for this section, as help and an error list them. */
    readonly settable: readonly string[];
    /** Whether `set <key>` belongs to this section. */
    owns(key: string): boolean;
    /** The section after `set <key> <value>`. Throws the message `set` prints for a bad key or value. */
    set(current: T, key: string, value: string, context: Context): T;
    /** The hook entries this feature needs wired, given its settings and an install's overrides. */
    entries(value: T, overrides: HookInstallOverrides): readonly HookEntryKind[];
    /** Its rows in `doctor`'s settings table, in the order they print. */
    doctor(value: T, facts: Facts): readonly HookDoctorRow[];
}

export function hooksConfigPath(): string {
    return toolDataDir("agents", "hooks.json");
}

/** The writers' copy of the defaults at write time, kept in the same file; not a setting. */
export const SHIPPED_DEFAULTS_KEY = "_shippedDefaults";
/** The installer's record of what it wired, kept in the same file; not a setting. */
export const INSTALLED_KEY = "installed";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The parts of `value` that differ from `fallback`, or `undefined` when nothing does.
 *
 * 🛑 Only overrides may take effect. `applySetting` works on the fully resolved config, so a file
 * read verbatim froze every default it listed: observed 2026-09-22, one `diff.maxFiles` change
 * pinned ten unrelated settings, and a later default would never have reached that machine again.
 *
 * An array is compared whole. These are small literal lists, and a per-element merge would
 * make "the user cleared this list" indistinguishable from "the user did not touch it".
 */
export function changedOnly(value: unknown, fallback: unknown): unknown {
    if (Array.isArray(value) || Array.isArray(fallback)) {
        return SafeJSON.stringify(value) === SafeJSON.stringify(fallback) ? undefined : value;
    }

    if (isPlainRecord(value) && isPlainRecord(fallback)) {
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

/**
 * The user's overrides inside a stored `hooks.json`. Writers store EVERY setting, so the file
 * shows each knob, plus `_shippedDefaults`, the defaults at write time. A value counts as an
 * override only when it differs from that copy, so a default that changes later still reaches
 * every setting the user never touched. A file without the copy (hand-written, or older) is
 * all overrides, as before.
 */
export function storedOverrides(raw: unknown): Record<string, unknown> {
    if (!isPlainRecord(raw)) {
        return {};
    }

    const { [SHIPPED_DEFAULTS_KEY]: shipped, [INSTALLED_KEY]: _installed, ...settings } = raw;

    if (!isPlainRecord(shipped)) {
        return settings;
    }

    const overrides = changedOnly(settings, shipped);
    return isPlainRecord(overrides) ? overrides : {};
}

/** The overrides in the hooks config file, or the error that made it unreadable (no file is an error too). */
export function readStoredHooksConfig(
    path = hooksConfigPath()
): { stored: Record<string, unknown>; error?: undefined } | { stored: null; error: unknown } {
    try {
        return { stored: storedOverrides(SafeJSON.parse(readFileSync(path, "utf8"))) };
    } catch (error) {
        // No config file is the normal case, not an error: the defaults ARE the shipped configuration.
        return { stored: null, error };
    }
}

/** One section of the hooks config as the hooks load it: its defaults when the file is missing or unreadable. */
export function loadHookConfigSection<T>(section: HookConfigSection<T>, path = hooksConfigPath()): T {
    const { stored } = readStoredHooksConfig(path);
    if (!stored) {
        return section.defaults();
    }

    return section.merge(section.key === null ? stored : stored[section.key], []);
}

/**
 * Every number in this config is a count: files, lines, bytes, notes. So it must be a whole
 * number, and at least 1 unless zero means something (`contextLines: 0` is `git diff -U0`, a
 * `contextCapPerSession` of 0 shows no context notes). `-1`, `2.5` and `NaN` used to pass: a
 * negative `maxLogBytes` rotated the log on every record.
 */
export function isCount(value: unknown, min: number): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= min;
}

export interface CheckedNumber {
    /** Where the value sits in `hooks.json`, for the problem `hooks doctor` prints. */
    field: string;
    value: unknown;
    fallback: number;
}

/**
 * A stored value that was present but rejected. `hooks doctor` prints these, so a hand-edited
 * `"maxFiles": "15"` is named instead of silently turning into the default. An absent field is
 * not a problem.
 */
export function reportRejected(problems: string[], { field, value, fallback }: CheckedNumber, expected: string): void {
    if (value !== undefined) {
        problems.push(`${field} is ${SafeJSON.stringify(value)}, not ${expected}; using ${fallback}`);
    }
}

/** A hand-edited value outside its count domain (or not a number at all) falls back to the default. */
export function countOr(problems: string[], checked: CheckedNumber & { min?: number }): number {
    const min = checked.min ?? 1;

    if (isCount(checked.value, min)) {
        return checked.value;
    }

    reportRejected(problems, checked, `a whole number of at least ${min}`);
    return checked.fallback;
}

/**
 * An MB cap is a size, not a count: `0.256` is a valid per-file ceiling, so the whole-number
 * check of `isCount` would reject the shipped default. It must still be a positive finite number,
 * because `0` or a negative cap would leave nothing to capture or log.
 */
export function isMegabytes(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function megabytesOr(problems: string[], checked: CheckedNumber): number {
    if (isMegabytes(checked.value)) {
        return checked.value;
    }

    reportRejected(problems, checked, "a positive number");
    return checked.fallback;
}

/**
 * The byte-denominated caps an older `hooks.json` may still carry were renamed to MB; reading only the new names
 * silently dropped a stored cap back to the default. This reads one of them as MB.
 */
export function legacyMB(bytes: unknown): number | undefined {
    return typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0 ? bytes / 1_000_000 : undefined;
}

export function boolOr(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}

/** `value` when it is one of `choices`, else `fallback`. */
export function oneOf<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
    return choices.find((choice) => choice === value) ?? fallback;
}

/** A stored part as a record to read fields from: anything that is not a plain object reads as `{}`. */
export function partOf(value: unknown): Record<string, unknown> {
    return isPlainRecord(value) ? value : {};
}

/**
 * A stored section as its merge reads it: a plain object, else `{}`. The merge checks every field it takes over the
 * defaults; this only names the shape it looks for.
 */
export function storedPart<T>(value: unknown): Partial<T> {
    return isPlainRecord(value) ? (value as Partial<T>) : {};
}

/** `a or b`, `a, b or c`. */
export function listed(choices: readonly string[]): string {
    return choices.length < 2 ? (choices[0] ?? "") : `${choices.slice(0, -1).join(", ")} or ${choices.at(-1)}`;
}

export function asBoolean(key: string, value: string): boolean {
    if (value === "true" || value === "false") {
        return value === "true";
    }

    throw new Error(`${key} takes true or false, not ${SafeJSON.stringify(value)}`);
}

/** `on` and `off`, or `true` and `false`: a feature switch reads either way. */
export function asSwitch(key: string, value: string): boolean {
    if (value === "on" || value === "off") {
        return value === "on";
    }

    return asBoolean(key, value);
}

/** The same count domain the loader enforces, so `config set` cannot persist what a load would drop. */
export function asCount(key: string, value: string, min = 1): number {
    const parsed = Number(value);

    if (value.trim() === "" || !isCount(parsed, min)) {
        throw new Error(`${key} takes a whole number of at least ${min}, not ${SafeJSON.stringify(value)}`);
    }

    return parsed;
}

/** An MB cap: any positive number, because `0.256` is a valid per-file ceiling. */
export function asMegabytes(key: string, value: string): number {
    const parsed = Number(value);

    if (value.trim() === "" || !isMegabytes(parsed)) {
        throw new Error(`${key} takes a number of MB greater than 0, not ${SafeJSON.stringify(value)}`);
    }

    return parsed;
}
