import { createMetricsRecorder, type MetricsRecorder } from "@genesiscz/utils/metrics";
import type { HooksConfig } from "./config";
import type { GuardVerdict } from "./guard";
import { guardLoop } from "./guard";
import type { HookPayload } from "./payload";

/** The tools metrics project and metric of one shell guard firing. */
export const GUARD_METRIC = { project: "agent-context", metric: "guard.verdict" } as const;

/**
 * What became of one firing rule:
 * - `block`, `warn`, `context`: its text reached the model with that outcome;
 * - `quiet`: a warn or a note the loop saw within `guard.quietMinutes`, so nothing was shown;
 * - `capped`: a context note over `guard.contextCapPerSession`;
 * - `behind-block`: a warn or a note in a command that a block stopped, so only the block was shown.
 */
export type GuardDelivery = "block" | "warn" | "context" | "quiet" | "capped" | "behind-block";

let recorder: MetricsRecorder | undefined;

function hookRecorder(): MetricsRecorder {
    // Buffered and written once, on the hook's exit: one append to the spool, no service and no SQLite.
    recorder ??= createMetricsRecorder({ writer: "agents-hooks" });
    return recorder;
}

function deliveryOf(verdict: GuardVerdict, ruleId: string, outcome: GuardVerdict["outcome"]): GuardDelivery {
    if (verdict.seenRules.includes(ruleId)) {
        return outcome === "allow" ? "context" : outcome;
    }

    if (verdict.quieted.includes(ruleId)) {
        return "quiet";
    }

    return verdict.outcome === "block" ? "behind-block" : "capped";
}

/**
 * One `agent-context / guard.verdict` event per firing rule. The value is the estimated tokens (characters / 4) of the
 * message the model got, split evenly over the rules in it; a rule that showed nothing has value 0, so `sum` is the
 * guard's context cost and `count` its firings. Never throws: a metric must not stop a command.
 */
export function recordGuardVerdict(options: {
    payload: HookPayload;
    verdict: GuardVerdict | null;
    config: HooksConfig;
    recorder?: MetricsRecorder;
}): void {
    const { payload, verdict, config } = options;

    if (!verdict || !config.guard.metrics) {
        return;
    }

    const target = options.recorder ?? hookRecorder();
    const delivered = config.shadow ? [] : verdict.seenRules;
    const tokens = delivered.length > 0 ? Math.ceil(verdict.message.length / 4) : 0;
    const share = delivered.length > 0 ? Math.round(tokens / delivered.length) : 0;
    const seen = new Set<string>();

    for (const violation of verdict.violations) {
        if (seen.has(violation.ruleId)) {
            continue;
        }

        seen.add(violation.ruleId);
        const delivery = deliveryOf(verdict, violation.ruleId, violation.outcome);
        const shown = delivered.includes(violation.ruleId);

        target.record(
            GUARD_METRIC.project,
            GUARD_METRIC.metric,
            shown ? share : 0,
            {
                session: payload.sessionId ?? null,
                agent: guardLoop(payload),
                harness: payload.harness,
                model: payload.model.length > 0 ? payload.model : null,
                rule: violation.ruleId,
                kind: violation.kind,
                outcome: violation.outcome,
                delivery,
                form: shown ? (verdict.explainedRules.includes(violation.ruleId) ? "full" : "compact") : "none",
                demoted: verdict.demoted.includes(violation.ruleId),
                shadow: config.shadow,
            },
            { chars: shown ? verdict.message.length : 0, rules: verdict.violations.length }
        );
    }
}
