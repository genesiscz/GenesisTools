import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { logger } from "@genesiscz/utils/logger";
import type { ToolCatalogue } from "./catalogue";
import { type RouteDecision, routeUtterance } from "./router";

const { log } = logger.scoped("jev-route");

export const MAX_PLAN_STEPS = 5;

export interface RoutePlan {
    steps: RouteDecision[];
    /** Set when the plan stopped early; the remaining parts were never routed. */
    blocked?: string;
    requests: number;
}

/**
 * Split an utterance on "then" / "and then" / "after that" into at most five parts.
 */
export function splitPlanUtterance(utterance: string): string[] {
    return utterance
        .split(/\s+(?:and\s+then|then|after\s+that)\s+/i)
        .map((part) => part.trim())
        .filter(Boolean)
        .slice(0, MAX_PLAN_STEPS);
}

/**
 * Route each step of a multi-part utterance.
 *
 * The plan stops at the first destructive step unless `allowDestructive` is set, so a sentence
 * that ends in a delete never silently prints a runnable command for it. Each step sees the
 * paths chosen before it, which is what lets "and then show the threads on it" resolve.
 */
export async function routePlan(options: {
    utterance: string;
    catalogue: ToolCatalogue;
    evaluate: Evaluator;
    signal?: AbortSignal;
    allowDestructive?: boolean;
}): Promise<RoutePlan> {
    const parts = splitPlanUtterance(options.utterance);
    log.info({ steps: parts.length }, "Routing a multi-step utterance");
    const steps: RouteDecision[] = [];
    const chosen: string[] = [];
    let requests = 0;
    for (const part of parts) {
        const context = chosen.length ? `${part} (previous steps: ${chosen.join("; ")})` : part;
        const step = await routeUtterance({
            utterance: context,
            catalogue: options.catalogue,
            evaluate: options.evaluate,
            signal: options.signal,
        });
        requests += step.requests;
        steps.push({ ...step, utterance: part });
        if (step.command) {
            chosen.push(step.command);
        }

        if (step.destructive && !options.allowDestructive) {
            log.warn({ command: step.command }, "Plan stopped at a destructive step");
            return { steps, blocked: "destructive_blocked", requests };
        }
    }

    return { steps, requests };
}

/**
 * The zsh line-editor widget, printed for the user to paste. Nothing is written to ~/.zshrc.
 */
export function zshRouteWidget(): string {
    return `#compdef -z jev-route
jev-route() {
  local suggestion
  suggestion=$(tools jev route --suggest -- "$LBUFFER" 2>/dev/null) || return
  [[ -n $suggestion ]] && LBUFFER=$suggestion
}
zle -N jev-route
# bindkey not installed by jev; add in tools zsh if wanted
`;
}
