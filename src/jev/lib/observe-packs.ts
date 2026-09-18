export const OBSERVE_PACKS = ["default", "browser-chrome", "form", "list"] as const;
export type ObservePack = (typeof OBSERVE_PACKS)[number];

export function parseObservePack(raw: string | undefined): ObservePack {
    const pack = (raw ?? "default") as ObservePack;
    if (!OBSERVE_PACKS.includes(pack)) {
        throw new Error(`Unknown observe pack '${raw}'. Valid: ${OBSERVE_PACKS.join(", ")}`);
    }
    return pack;
}

export function packQuestions(pack: ObservePack): Record<string, unknown> {
    if (pack === "browser-chrome") {
        return {
            tab: { type: "boolean", instructions: "Is the intended tab already selected?" },
            back: { type: "boolean", instructions: "Would history.back advance the goal?" },
            url_matches: { type: "boolean", instructions: "Does the current URL already satisfy the goal?" },
        };
    }
    if (pack === "form") {
        return {
            missing_required: { type: "boolean", instructions: "Are required fields still empty?" },
            submit_safe: { type: "boolean", instructions: "Is it safe to submit with the observed values?" },
        };
    }
    if (pack === "list") {
        return {
            row_match: { type: "boolean", instructions: "Is the intended row visible in this list?" },
        };
    }
    return {};
}
