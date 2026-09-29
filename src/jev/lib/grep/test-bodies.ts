import type { Snapshot } from "./filesystem";
import type { EvidenceRange, Excerpt, FileEvidence } from "./types";

export interface TestBodyChange {
    file: FileEvidence;
    presentationExcerpts: Excerpt[];
    presentationSelected: EvidenceRange[];
}

/**
 * Upstream narrows the displayed bodies of Python test functions with one more Jev pass, using its
 * bundled CPython to find them. Without an interpreter there are no test-function units to choose
 * from, so this returns no change and never calls Jev. It may narrow a test file later; it must never
 * drop the file.
 */
export async function selectTestBodies(
    _inputs: Array<{ snapshot: Snapshot; file: FileEvidence }>
): Promise<TestBodyChange[]> {
    return [];
}
