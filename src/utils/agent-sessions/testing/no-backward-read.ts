import type { BackwardRead, RowAnchorWalk } from "../types";

/** `readBackward` for a test reader whose test never walks a session backwards. */
export async function noBackwardRead(): Promise<BackwardRead> {
    return { entries: [], found: false, issues: [] };
}

/** `continuedIn` for a test reader whose sessions are never continued elsewhere. */
export async function noContinuedIn(): Promise<string | undefined> {
    return undefined;
}

/** `modelOfRow` for a test reader whose rows never name a model. */
export function noModelOfRow(): string | undefined {
    return undefined;
}

/** `indexesFile` for a test reader that no file watcher asks. */
export function indexesNoFile(): boolean {
    return false;
}

/** `rowAnchors` for a test reader whose rows carry no native ids. */
export function noRowAnchors(): RowAnchorWalk {
    return () => ({ messageIds: [], toolCallIds: [], turnIds: [] });
}
