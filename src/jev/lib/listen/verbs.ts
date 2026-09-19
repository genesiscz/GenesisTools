import { type Candidate, candidatesFor, type Observation } from "@app/control/lib/decision/observation";
import { prefixCandidateId, type SurfacePrefix } from "../loop/prefix";

export const CHROME_VERBS = ["back", "next_tab", "prev_tab", "close_tab", "reload"] as const;
export type ChromeVerb = (typeof CHROME_VERBS)[number];

export interface ListenCandidate {
    id: string;
    label: string;
    action: "press" | "set" | "chrome" | "menu" | "app" | "narrow" | "confirm";
    element: number;
    chrome?: ChromeVerb;
    /** Menu item reference from the native menu session (`action: "menu"`). */
    menuRef?: string;
    /** Semantic row identity, when the surface computes one; the freshness check prefers it. */
    targetKey?: string;
    /** Process to bring forward (`action: "app"`). */
    appPid?: number;
    /** Which narrowing this row applies (`action: "narrow"`). */
    narrow?: string;
    /** Role as the surface reports it; the narrowing filters read it. */
    role?: string;
}

/**
 * The choosable set is what the app exposes: its observed pressable rows (with `--scope chrome`
 * that includes a browser's tab strip and toolbar) plus, when the caller passes them, its menu
 * items. The fixed CDP chrome verbs are added only for a CDP-bound browser surface; they are not
 * a substitute for the app's own accessibility tree.
 */
export function listenCandidates(
    observation: Observation,
    options: { prefix?: SurfacePrefix; chromeVerbs?: boolean; menuItems?: ListenCandidate[] } | SurfacePrefix = {}
): ListenCandidate[] {
    const resolved = typeof options === "string" ? { prefix: options, chromeVerbs: true } : options;
    const prefix = resolved.prefix;
    const rows = candidatesFor({ observation, action: "press" });
    const items: ListenCandidate[] = rows.map((candidate: Candidate) => ({
        id: prefix ? prefixCandidateId(prefix, candidate.id) : candidate.id,
        label: candidate.label,
        action: "press",
        element: candidate.element,
        role: candidate.role,
        ...(candidate.targetKey === undefined ? {} : { targetKey: candidate.targetKey }),
    }));
    for (const item of resolved.menuItems ?? []) {
        items.push(item);
    }

    if (resolved.chromeVerbs === false) {
        return items;
    }

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

/**
 * "switch to <app>" rows. An app switch is not a row of the observed screen, so it is offered
 * alongside the screen's own candidates rather than derived from them, and acting on one rebinds
 * what the next utterance controls.
 */
export function appSwitchCandidates(apps: { pid: number; app: string }[]): ListenCandidate[] {
    return apps.map((entry) => ({
        id: `app:${entry.pid}`,
        label: `switch to ${entry.app}`,
        action: "app" as const,
        element: -1,
        appPid: entry.pid,
    }));
}

/** The fixed CDP verbs, offered only when the surface is a CDP-bound browser. */
export function chromeVerbCandidates(prefix?: SurfacePrefix): ListenCandidate[] {
    return CHROME_VERBS.map((verb) => ({
        id: prefix ? prefixCandidateId(prefix, verb) : verb,
        label: verb.replaceAll("_", " "),
        action: "chrome" as const,
        element: -1,
        chrome: verb,
    }));
}

export function listenCriteria(candidates: ListenCandidate[]): Record<string, string> {
    return {
        ...Object.fromEntries(candidates.map((item) => [item.id, `${item.action}: ${item.label}`])),
        abstain: "No unique appropriate observed target or chrome verb.",
    };
}
