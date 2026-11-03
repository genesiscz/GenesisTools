import type { SessionAnalysisReader } from "../analysis-types";
import type { BackwardRead, RowAnchorWalk } from "../types";

/** `readBackward` for a test reader whose test never walks a session backwards. */
export async function noBackwardRead(): Promise<BackwardRead> {
    return { entries: [], found: false, issues: [] };
}

/** `continuedIn` for a test reader whose sessions are never continued elsewhere. */
export async function noContinuedIn(): Promise<string | undefined> {
    return undefined;
}

/** `currentModel` for a test reader whose sessions never name a model. */
export function noCurrentModel(): string | null {
    return null;
}

/** `classifyPath` for a test reader that no file watcher asks. */
export function classifiesNoPath(): null {
    return null;
}

/** `rowAnchors` for a test reader whose rows carry no native ids. */
export function noRowAnchors(): RowAnchorWalk {
    return () => ({ messageIds: [], toolCallIds: [], turnIds: [] });
}

/** `readChanges` for a test reader whose sessions record no file changes. */
export function noSessionChanges(): null {
    return null;
}

/** `analysis` for a test reader whose test never analyses a session: every fact answers that it cannot. */
export const noAnalysis: SessionAnalysisReader = {
    callTrace: async () => ({ supported: false, reason: "test reader" }),
    compactions: async () => ({ supported: false, reason: "test reader" }),
    quotaReadings: async () => ({ supported: false, reason: "test reader" }),
};
