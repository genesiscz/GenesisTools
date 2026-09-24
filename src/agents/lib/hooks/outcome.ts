import type { ShellRuleKind, ShellSeverity } from "@genesiscz/utils/shell/rules/types";
import type { GuardConfig, HarnessName, HookOutcome } from "./config";

export interface OutcomeInput {
    ruleId: string;
    ruleSeverity: ShellSeverity;
    kind: ShellRuleKind;
    harness: HarnessName;
    model: string;
    command: string;
    config: GuardConfig;
}

/** The trace layer that marks a `misread` block softened by command length. */
export const LONG_MISREAD_DOWNGRADE = "long misread downgrade";

export interface OutcomeResult {
    outcome: HookOutcome;
    /** Every layer that moved the outcome, so `doctor` can show the derivation. */
    trace: [string, string][];
}

/**
 * `opus` matches exactly; `opus[*` and `*sonnet*` are globs. Case-insensitive, because
 * `settings.json` stores selector aliases such as `opus[1m]` while a transcript stores
 * `claude-opus-5`. Ported from `modelMatches` in the guard this replaces; changing the
 * escape set or the case flag silently changes which override wins.
 */
export function matchesGlob(value: string, pattern: string): boolean {
    const escaped = pattern
        .replace(/[.+^${}()|\\]/g, "\\$&")
        .replace(/\[/g, "\\[")
        .replace(/\]/g, "\\]")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");

    return new RegExp(`^${escaped}$`, "i").test(value);
}

/**
 * Order: the rule's own severity, then `default`, then `harnesses.<name>`, then the
 * first matching `models` glob. Finally the length downgrade, which only ever
 * softens a `misread`.
 */
export function resolveOutcome(input: OutcomeInput): OutcomeResult {
    const { ruleId, ruleSeverity, kind, harness, model, command, config } = input;
    const trace: [string, string][] = [];
    let outcome: HookOutcome = ruleSeverity;

    trace.push(["rule default", outcome]);

    const fromDefault = config.default?.[ruleId];
    if (fromDefault) {
        outcome = fromDefault;
        trace.push(["default", outcome]);
    }

    const fromHarness = config.harnesses?.[harness]?.[ruleId];
    if (fromHarness) {
        outcome = fromHarness;
        trace.push([`harnesses.${harness}`, outcome]);
    }

    // First MATCHING pattern wins and ends the search, even when it carries no override
    // for this rule. A later pattern that also matches is deliberately not consulted.
    if (model.length > 0) {
        for (const [pattern, rules] of Object.entries(config.models ?? {})) {
            if (!matchesGlob(model, pattern)) {
                continue;
            }

            const override = rules?.[ruleId];

            if (override) {
                outcome = override;
                trace.push([`models.${pattern}`, outcome]);
            }

            break;
        }
    }

    const lines = command.split("\n").length;
    const chars = command.length;
    const long = lines >= config.longCommand.lines || chars >= config.longCommand.chars;

    trace.push(["length", `${lines} lines / ${chars} chars, long=${long}`]);

    if (long && outcome === "block" && kind === "misread") {
        outcome = "warn";
        trace.push([LONG_MISREAD_DOWNGRADE, outcome]);
    }

    return { outcome, trace };
}
