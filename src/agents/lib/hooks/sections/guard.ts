import {
    asBoolean,
    asCount,
    boolOr,
    countOr,
    type HookConfigSection,
    storedPart,
} from "@genesiscz/utils/agents/hooks/config-section";
import { ACCOUNT_PROVIDER_ALIASES, byHarnessWhere } from "@genesiscz/utils/ai/providers/alias-list";
import { harnessHooks } from "@genesiscz/utils/ai/providers/harness-hooks";
import { SafeJSON } from "@genesiscz/utils/json";
import type { GuardConfig, HookDoctorFacts, HookOutcome, HookSetContext } from "../config";

/**
 * `longCommand` at 30 lines / 2500 chars: at or above either size a `misread` block
 * becomes a warn, because re-running a long script over one line costs more than
 * reading the note. `destructive` rules always block regardless of length.
 *
 * The zsh glob qualifier only misfires under Claude Code, which sets
 * NO_BARE_GLOB_QUAL; a harness whose own zsh honours `(N)` allows it (`honoursBareGlobQualifier`).
 */
const DEFAULT_GUARD: GuardConfig = {
    enabled: true,
    default: {},
    harnesses: byHarnessWhere((id) =>
        harnessHooks(id).honoursBareGlobQualifier ? { "zsh-glob-qualifier": "allow" } : undefined
    ),
    models: {},
    longCommand: { lines: 30, chars: 2500 },
    contextCapPerSession: 3,
    customRules: [],
};

/** Each harness's rules merged over the shipped ones for that harness. */
function mergeHarnesses(
    base: GuardConfig["harnesses"],
    stored: GuardConfig["harnesses"] | undefined
): GuardConfig["harnesses"] {
    const merged: GuardConfig["harnesses"] = { ...base };

    for (const harness of ACCOUNT_PROVIDER_ALIASES) {
        const rules = stored?.[harness];

        if (rules) {
            merged[harness] = { ...base[harness], ...rules };
        }
    }

    return merged;
}

/** A list of paths: anything but an array of strings falls back, and is reported. */
function pathListOr(problems: string[], field: string, value: unknown, fallback: string[]): string[] {
    if (value === undefined) {
        return fallback;
    }

    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
        return value.filter((item) => item.trim().length > 0);
    }

    problems.push(
        `${field} is ${SafeJSON.stringify(value)}, not a list of paths; using ${SafeJSON.stringify(fallback)}`
    );

    return fallback;
}

function merge(value: unknown, problems: string[]): GuardConfig {
    const base = DEFAULT_GUARD;
    const guard = storedPart<GuardConfig>(value);

    return {
        enabled: boolOr(guard?.enabled, base.enabled),
        // The rule maps are merged per KEY, not replaced. A shallow spread let a hand-edited
        // `hooks.json` that sets only `harnesses.claude` drop the shipped codex and grok
        // `zsh-glob-qualifier: allow`, so both harnesses started refusing a valid `(N)`.
        default: { ...base.default, ...guard?.default },
        harnesses: mergeHarnesses(base.harnesses, guard?.harnesses),
        models: { ...base.models, ...guard?.models },
        // `longCommand` is merged FIELD BY FIELD. A shallow spread let a hand-edited
        // `hooks.json` that sets only `guard.longCommand.lines` blank `chars`, and
        // `chars >= undefined` is always false, so the character threshold silently
        // stopped working. A value that is not a finite number is dropped the same way.
        longCommand: {
            lines: countOr(problems, {
                field: "guard.longCommand.lines",
                value: guard?.longCommand?.lines,
                fallback: base.longCommand.lines,
            }),
            chars: countOr(problems, {
                field: "guard.longCommand.chars",
                value: guard?.longCommand?.chars,
                fallback: base.longCommand.chars,
            }),
        },
        contextCapPerSession: countOr(problems, {
            field: "guard.contextCapPerSession",
            value: guard?.contextCapPerSession,
            fallback: base.contextCapPerSession,
            min: 0,
        }),
        customRules: pathListOr(problems, "guard.customRules", guard?.customRules, base.customRules),
    };
}

const OUTCOMES: readonly HookOutcome[] = ["allow", "context", "warn", "block"];
function asOutcome(key: string, value: string): HookOutcome {
    if ((OUTCOMES as readonly string[]).includes(value)) {
        return value as HookOutcome;
    }

    throw new Error(`${key} takes one of ${OUTCOMES.join(", ")}, not ${SafeJSON.stringify(value)}`);
}

const GUARD_KEYS: ReadonlySet<string> = new Set([
    "enabled",
    "guard.enabled",
    "guard.longCommand.lines",
    "guard.longCommand.chars",
    "guard.contextCapPerSession",
    "guard.customRules",
]);
const RULE_KEY = /^rules\.(.+)$/;
const HARNESS_RULE_KEY = /^harnesses\.([^.]+)\.(.+)$/;

function set(current: GuardConfig, key: string, value: string, { ruleIds }: HookSetContext): GuardConfig {
    const next: GuardConfig = {
        ...current,
        default: { ...current.default },
        harnesses: { ...current.harnesses },
        longCommand: { ...current.longCommand },
    };

    if (key === "enabled" || key === "guard.enabled") {
        next.enabled = asBoolean(key, value);
        return next;
    }

    if (key === "guard.longCommand.lines" || key === "guard.longCommand.chars") {
        next.longCommand[key.endsWith("lines") ? "lines" : "chars"] = asCount(key, value);
        return next;
    }

    if (key === "guard.contextCapPerSession") {
        next.contextCapPerSession = asCount(key, value, 0);
        return next;
    }

    if (key === "guard.customRules") {
        // A comma list of files or folders; an empty value clears it.
        next.customRules = value
            .split(",")
            .map((path) => path.trim())
            .filter(Boolean);
        return next;
    }

    const rule = RULE_KEY.exec(key);

    if (rule?.[1]) {
        if (!ruleIds.has(rule[1])) {
            throw new Error(`no such rule: ${rule[1]}`);
        }

        next.default[rule[1]] = asOutcome(key, value);
        return next;
    }

    const perHarness = HARNESS_RULE_KEY.exec(key);
    const harness = ACCOUNT_PROVIDER_ALIASES.find((name) => name === perHarness?.[1]);
    const ruleId = perHarness?.[2] ?? "";

    if (!harness) {
        throw new Error(`no such harness: ${perHarness?.[1]}`);
    }

    if (!ruleIds.has(ruleId)) {
        throw new Error(`no such rule: ${ruleId}`);
    }

    next.harnesses[harness] = { ...(next.harnesses[harness] ?? {}), [ruleId]: asOutcome(key, value) };
    return next;
}

/** The shell guard's part of `hooks.json`: the rule outcomes, the long-command threshold, the custom rules. */
export const GUARD_HOOK_SECTION: HookConfigSection<GuardConfig, HookDoctorFacts, HookSetContext> = {
    key: "guard",
    defaults: () => structuredClone(DEFAULT_GUARD),
    merge,
    settable: [
        "enabled",
        "guard.longCommand.lines",
        "guard.longCommand.chars",
        "guard.contextCapPerSession",
        "guard.customRules",
        "rules.<rule-id>",
        `harnesses.<${ACCOUNT_PROVIDER_ALIASES.join("|")}>.<rule-id>`,
    ],
    owns: (key) => GUARD_KEYS.has(key) || RULE_KEY.test(key) || HARNESS_RULE_KEY.test(key),
    set,
    // The guard runs in the one PreToolUse process the diff capture shares.
    entries: () => ["bash-pre"],
    doctor: (guard, facts) => [
        ["guard.enabled", String(guard.enabled)],
        ["guard rules", `${facts.rules.builtIn} built-in, ${facts.rules.custom} custom`],
        ["rules switched off", facts.rules.off || "none"],
        ["rules allowed per harness", facts.rules.perHarness || "none"],
        ["longCommand", `${guard.longCommand.lines} lines / ${guard.longCommand.chars} chars`],
        ["contextCapPerSession", String(guard.contextCapPerSession)],
    ],
};
