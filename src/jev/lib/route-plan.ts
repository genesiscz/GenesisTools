import type { ToolInfo } from "@app/tools/lib/discovery";
import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { type RouteSuggestion, routeUtterance } from "./route";

export function splitPlanUtterance(utterance: string): string[] {
    return utterance
        .split(/\s+(?:then|and then|after that)\s+/i)
        .map((part) => part.trim())
        .filter(Boolean)
        .slice(0, 5);
}

export async function routePlan(options: {
    utterance: string;
    srcDir: string;
    evaluate: Evaluator;
    run?: boolean;
    allowDestructive?: boolean;
    tools?: ToolInfo[];
}): Promise<{ steps: RouteSuggestion[]; blocked?: string }> {
    const parts = splitPlanUtterance(options.utterance);
    const steps: RouteSuggestion[] = [];
    for (const part of parts) {
        const step = await routeUtterance({ ...options, utterance: part, run: false });
        steps.push(step);
        if (step.destructive && options.run && !options.allowDestructive) {
            return { steps, blocked: "destructive_blocked" };
        }
    }
    return { steps };
}

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
