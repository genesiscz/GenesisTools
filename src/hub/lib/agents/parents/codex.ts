import { buildCodexParent } from "../codex-agents";
import { type ParentBuilder, startedAtOf } from "../parent";

/** A Codex session's parent: built from the agent records of the rollouts that name it. */
export const parentPart: ParentBuilder = (row, context) =>
    buildCodexParent(row, context.codexAgentsOf(row.sessionId), context.now, startedAtOf(row.filePath));
