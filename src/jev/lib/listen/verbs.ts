import { type Candidate, candidatesFor, type Observation } from "@app/control/lib/decision/observation";
import { prefixCandidateId, type SurfacePrefix } from "../loop/prefix";

export const CHROME_VERBS = ["back", "next_tab", "prev_tab", "close_tab", "reload"] as const;
export type ChromeVerb = (typeof CHROME_VERBS)[number];

export interface ListenCandidate {
    id: string;
    label: string;
    action: "press" | "set" | "chrome";
    element: number;
    chrome?: ChromeVerb;
}

export function listenCandidates(observation: Observation, prefix?: SurfacePrefix): ListenCandidate[] {
    const rows = candidatesFor({ observation, action: "press" });
    const items: ListenCandidate[] = rows.map((candidate: Candidate) => ({
        id: prefix ? prefixCandidateId(prefix, candidate.id) : candidate.id,
        label: candidate.label,
        action: "press",
        element: candidate.element,
    }));
    for (const verb of CHROME_VERBS) {
        items.push({
            id: verb,
            label: verb.replaceAll("_", " "),
            action: "chrome",
            element: -1,
            chrome: verb,
        });
    }
    return items;
}

export function listenCriteria(candidates: ListenCandidate[]): Record<string, string> {
    return {
        ...Object.fromEntries(candidates.map((item) => [item.id, `${item.action}: ${item.label}`])),
        abstain: "No unique appropriate observed target or chrome verb.",
    };
}
