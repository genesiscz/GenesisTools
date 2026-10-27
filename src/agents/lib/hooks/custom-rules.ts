import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ShellMatch, ShellRule, ShellRuleKind, ShellSeverity } from "@genesiscz/utils/shell/rules/types";
import type { HooksConfig } from "./config";
import { hookDiag } from "./log";
import { BUILT_IN_RULES } from "./tool-rules";

/**
 * Custom rules: shell rules that live OUTSIDE this repository (a user's own folder) and run in the
 * same guard as the built-in ones.
 *
 * 🛑 The guard runs on every Bash call of every session, so nothing here may break it. A module
 * that fails to import, exports the wrong shape, or never finishes importing is skipped and
 * reported; a rule whose `detect` throws or returns garbage is skipped for that command. The guard
 * then runs the rules that did load. Hot path: no logger, no Storage (see `config.ts`).
 */

export interface RefusedRule {
    /** The rule's id, or `#<index>` in the exported array when it has none. */
    id: string;
    reason: string;
}

export interface CustomRuleModule {
    /** The module file, absolute. */
    file: string;
    /** The `guard.customRules` entry it came from: the file itself, or its folder. */
    source: string;
    status: "loaded" | "failed";
    /** Why the module failed, when it did. */
    reason?: string;
    /** The rules this module added to the guard. */
    ruleIds: string[];
    /** Exported entries that were not taken, each with why. */
    refused: RefusedRule[];
}

export interface CustomRules {
    rules: ShellRule[];
    modules: CustomRuleModule[];
    /** Configured entries that name nothing loadable. */
    missing: { source: string; reason: string }[];
}

export interface DetectFailure {
    ruleId: string;
    file: string;
    err: unknown;
}

export interface LoadOptions {
    /** Ids already taken. Default: every built-in rule. */
    builtinIds?: ReadonlySet<string>;
    /** Called when a custom rule's `detect` throws or returns a value that is not a match. */
    onDetectError?: (failure: DetectFailure) => void;
    timeoutMs?: number;
}

/** A module that has not finished importing by then is reported as failed. */
export const CUSTOM_IMPORT_TIMEOUT_MS = 3_000;

const MODULE_FILE = /\.(?:ts|mts|js|mjs)$/;
const SKIPPED_FILE = /\.(?:test|spec)\.|\.d\.ts$/;
const RULE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const KINDS: readonly ShellRuleKind[] = ["misread", "destructive"];
const SEVERITIES: readonly ShellSeverity[] = ["block", "context", "warn"];

/** `~/x` and `~` expand; a relative path resolves against the home folder. */
export function expandRulePath(entry: string): string {
    const trimmed = entry.trim();

    if (trimmed === "~") {
        return homedir();
    }

    if (trimmed.startsWith("~/")) {
        return join(homedir(), trimmed.slice(2));
    }

    return isAbsolute(trimmed) ? trimmed : resolve(homedir(), trimmed);
}

function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** The module files one entry names, or why it names none. */
function moduleFiles(path: string): { files: string[] } | { reason: string } {
    let isDirectory: boolean;

    try {
        isDirectory = statSync(path).isDirectory();
    } catch (err) {
        return { reason: `cannot read it: ${messageOf(err)}` };
    }

    if (!isDirectory) {
        return MODULE_FILE.test(path) ? { files: [path] } : { reason: "not a .ts, .mts, .js or .mjs file" };
    }

    const files = readdirSync(path)
        .filter((name) => MODULE_FILE.test(name) && !SKIPPED_FILE.test(name))
        .filter((name) => !name.startsWith(".") && !name.startsWith("_"))
        .sort()
        .map((name) => join(path, name));

    return { files };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function nonEmpty(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

/** Why `value` is not a usable rule, or `null` when it is one. */
export function ruleProblem(value: unknown): string | null {
    if (!isRecord(value)) {
        return "not an object";
    }

    if (typeof value.id !== "string" || !RULE_ID.test(value.id)) {
        return "id must be a kebab-case string";
    }

    if (!KINDS.includes(value.kind as ShellRuleKind)) {
        return `kind must be one of ${KINDS.join(", ")}`;
    }

    if (!SEVERITIES.includes(value.severity as ShellSeverity)) {
        return `severity must be one of ${SEVERITIES.join(", ")}`;
    }

    for (const field of ["title", "why", "wrong", "right"] as const) {
        if (!nonEmpty(value[field])) {
            return `${field} must be a non-empty string`;
        }
    }

    if (value.evidence !== undefined && typeof value.evidence !== "string") {
        return "evidence must be a string when present";
    }

    if (typeof value.detect !== "function") {
        return "detect must be a function";
    }

    return null;
}

function isShellRule(value: unknown): value is ShellRule {
    return ruleProblem(value) === null;
}

function isMatch(value: unknown): value is ShellMatch {
    return (
        isRecord(value) &&
        typeof value.matched === "string" &&
        typeof value.index === "number" &&
        (value.suggestion === undefined || typeof value.suggestion === "string")
    );
}

/**
 * A copy of the rule whose `detect` cannot hurt the guard. The registry already skips a rule that
 * throws, but silently; this reports it, and it also refuses a return value that is not a match,
 * which the registry would otherwise render as `undefined` in the message the model reads.
 */
function guarded(rule: ShellRule, file: string, onError: (failure: DetectFailure) => void): ShellRule {
    const detect = rule.detect;

    return {
        id: rule.id,
        kind: rule.kind,
        title: rule.title,
        severity: rule.severity,
        why: rule.why,
        wrong: rule.wrong,
        right: rule.right,
        ...(rule.evidence !== undefined ? { evidence: rule.evidence } : {}),
        detect(scan) {
            let match: unknown;

            try {
                match = detect.call(rule, scan);
            } catch (err) {
                onError({ ruleId: rule.id, file, err });
                return null;
            }

            if (match === null || match === undefined) {
                return null;
            }

            if (!isMatch(match)) {
                onError({ ruleId: rule.id, file, err: new Error("detect returned a value that is not a ShellMatch") });
                return null;
            }

            return match;
        },
    };
}

async function importWithin(file: string, timeoutMs: number): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            import(file),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`import did not finish within ${timeoutMs} ms`)), timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function exportedRules(mod: unknown): unknown[] | null {
    if (!isRecord(mod)) {
        return null;
    }

    const exported = mod.rules ?? mod.default;

    return Array.isArray(exported) ? exported : null;
}

function defaultDetectError(failure: DetectFailure): void {
    hookDiag("A custom rule failed while checking a command; it was skipped for that command", {
        ruleId: failure.ruleId,
        file: failure.file,
        err: failure.err,
    });
}

/**
 * Imports every module the entries name, in order, and returns the rules that are safe to run.
 * An id that is already taken (a built-in rule, or an earlier custom one) is refused, never
 * replaced: a custom module must not be able to switch a built-in rule off by shadowing it.
 */
export async function loadCustomRules(entries: readonly string[], options: LoadOptions = {}): Promise<CustomRules> {
    const taken = new Map<string, string>();
    const rules: ShellRule[] = [];
    const modules: CustomRuleModule[] = [];
    const missing: CustomRules["missing"] = [];
    const seen = new Set<string>();
    const onError = options.onDetectError ?? defaultDetectError;
    const timeoutMs = options.timeoutMs ?? CUSTOM_IMPORT_TIMEOUT_MS;

    for (const id of options.builtinIds ?? new Set(BUILT_IN_RULES.map((rule) => rule.id))) {
        taken.set(id, "a built-in rule");
    }

    for (const source of entries) {
        const listed = moduleFiles(expandRulePath(source));

        if ("reason" in listed) {
            missing.push({ source, reason: listed.reason });
            continue;
        }

        for (const file of listed.files) {
            if (seen.has(file)) {
                continue;
            }

            seen.add(file);

            const record: CustomRuleModule = { file, source, status: "loaded", ruleIds: [], refused: [] };
            modules.push(record);

            let exported: unknown[] | null;

            try {
                exported = exportedRules(await importWithin(file, timeoutMs));
            } catch (err) {
                record.status = "failed";
                record.reason = messageOf(err);
                continue;
            }

            if (!exported) {
                record.status = "failed";
                record.reason = "it exports no `rules` array (and no default array)";
                continue;
            }

            for (const [index, value] of exported.entries()) {
                const id = isRecord(value) && typeof value.id === "string" ? value.id : `#${index}`;
                const problem = ruleProblem(value);

                if (problem || !isShellRule(value)) {
                    record.refused.push({ id, reason: problem ?? "not a rule" });
                    continue;
                }

                const owner = taken.get(id);

                if (owner) {
                    record.refused.push({ id, reason: `the id is already used by ${owner}` });
                    continue;
                }

                taken.set(id, file);
                rules.push(guarded(value, file, onError));
                record.ruleIds.push(id);
            }
        }
    }

    return { rules, modules, missing };
}

export interface GuardRules {
    rules: readonly ShellRule[];
    /** `null` when no custom rules are configured, so nothing was imported. */
    custom: CustomRules | null;
}

/** The rules the guard runs: the built-in ones, plus the custom ones when any are configured. */
export async function guardRules(config: HooksConfig, options: LoadOptions = {}): Promise<GuardRules> {
    if (!config.guard.enabled || config.guard.customRules.length === 0) {
        return { rules: BUILT_IN_RULES, custom: null };
    }

    const custom = await loadCustomRules(config.guard.customRules, options);

    return { rules: [...BUILT_IN_RULES, ...custom.rules], custom };
}

/** One decision-log line per problem, so a broken module shows in `hooks log` as well as `doctor`. */
export function logCustomRuleProblems(custom: CustomRules | null): void {
    if (!custom) {
        return;
    }

    for (const entry of custom.missing) {
        hookDiag("A custom rule path names nothing loadable; it was skipped", {
            source: entry.source,
            why: entry.reason,
        });
    }

    for (const module of custom.modules) {
        if (module.status === "failed") {
            hookDiag("A custom rule module failed to load; it was skipped", { file: module.file, why: module.reason });
        }

        for (const refused of module.refused) {
            hookDiag("A custom rule was refused", { file: module.file, ruleId: refused.id, why: refused.reason });
        }
    }
}

export interface RuleSet {
    /** The built-in rules, then the custom ones that loaded. */
    rules: readonly ShellRule[];
    /** Where each rule comes from: `built-in`, or the custom module's file. */
    sources: ReadonlyMap<string, string>;
    custom: CustomRules | null;
}

export const BUILT_IN_SOURCE = "built-in";

/**
 * Every rule the CLI can name, for `rules list`, `config rules` and `config set rules.<id>`.
 * Unlike `guardRules` it loads the custom modules even while the guard is switched off, because
 * that is exactly when someone lists them to decide what to switch back on.
 */
export async function loadRuleSet(config: HooksConfig, options: LoadOptions = {}): Promise<RuleSet> {
    const sources = new Map<string, string>(BUILT_IN_RULES.map((rule) => [rule.id, BUILT_IN_SOURCE]));

    if (config.guard.customRules.length === 0) {
        return { rules: BUILT_IN_RULES, sources, custom: null };
    }

    const custom = await loadCustomRules(config.guard.customRules, options);

    for (const module of custom.modules) {
        for (const id of module.ruleIds) {
            sources.set(id, module.file);
        }
    }

    return { rules: [...BUILT_IN_RULES, ...custom.rules], sources, custom };
}
