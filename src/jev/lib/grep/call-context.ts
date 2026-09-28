import type { Snapshot } from "./filesystem";
import type { CallLead, Excerpt, FileEvidence } from "./types";

/**
 * Upstream finds calls from selected code to other declarations in the same file with its bundled
 * CPython, for Python only. This port has no interpreter, so the pass is a no-op that leaves the
 * excerpts as they are. A TypeScript walk may replace it later; it must read only this snapshot's
 * identifiers, never run `tsgo`, and never resolve imports into files the eligibility layer did not admit.
 */
export async function localCallContext(
    _snapshot: Snapshot,
    _file: FileEvidence
): Promise<{ presentationExcerpts: Excerpt[]; callLeads: CallLead[] } | undefined> {
    return undefined;
}
