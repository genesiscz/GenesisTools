import type { BackwardRead } from "../types";

/** `readBackward` for a test reader whose test never walks a session backwards. */
export async function noBackwardRead(): Promise<BackwardRead> {
    return { entries: [], found: false, issues: [] };
}

/** `continuedIn` for a test reader whose sessions are never continued elsewhere. */
export async function noContinuedIn(): Promise<string | undefined> {
    return undefined;
}
