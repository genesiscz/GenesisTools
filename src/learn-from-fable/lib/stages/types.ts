export interface SpecAxis {
    id?: string;
    text?: string;
}

/** One mined decision-point episode (SkillOpt §D.2 shape, camelCased). */
export interface Episode {
    id: string;
    sourceSession: string;
    taskType: string;
    /** Situation up to the decision point — actions/results only, NO thinking. */
    contextPrefix: string;
    /** Fable's actual next move: thinking gist + tool calls + visible text. */
    referenceAction: string;
    referenceOutcome: string;
    specAxes: SpecAxis[];
    /** Runner id that extracted this episode (results are kept per model). */
    minedBy: string;
    /**
     * Version of the deterministic assembly code (prefix/reference rendering).
     * Bump when that rendering changes so stale artifacts are findable instead of
     * silently mixed in — e.g. episodes mined before slash-command scaffolding was
     * stripped kept `<local-command-caveat>` noise in their prefixes.
     */
    parserVersion?: number;
    runId: string;
    /** Filled by the contrastive filter. */
    naiveScore?: number;
    referenceScore?: number;
    naiveReply?: string;
}

/** Unconsolidated principle candidate — accumulates until the consolidation stage votes. */
export interface PrincipleCandidate {
    sessionStem: string;
    minedBy: string;
    runId: string;
    principle: string;
    why: string;
    /** Turn index of the supporting evidence, when the extractor named one. */
    turn?: number;
}

export const TASK_TYPES = ["planning", "command-style", "verification", "reporting", "recovery", "judgment"] as const;
export type TaskType = (typeof TASK_TYPES)[number];
