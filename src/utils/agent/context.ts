import type { HarnessId } from "@genesiscz/utils/harness/types";
import type { SourceMessage } from "./source-anchor";

/**
 * What every agent host resolver produces. A leaf type module on purpose: it
 * imports nothing, so `host.ts` and each file under `hosts/` can all depend on
 * it without a cycle.
 *
 * It used to live in `claude/runtime-context.ts`, which made three other hosts
 * import their shared shape out of one host's folder. The fourth host (Copilot,
 * 2026-08-31) is what made that indefensible. `src/utils/claude/` stays where it
 * is — its other 30 files are Claude SDK, session and auth code, and have
 * nothing to do with which CLI host owns this process.
 */
export interface AgentRuntimeContext {
    /** Claude is `claude-code` here; the other harnesses keep their id; Copilot is a host but no harness. */
    agent: "claude-code" | Exclude<HarnessId, "claude"> | "copilot" | "unknown";
    sessionId: string | null;
    /** Native IDs provided by the calling harness, never inferred from transcript positions. */
    sourceMessage?: SourceMessage;
    isInAgent: boolean;
    aiAgent: string | null;
    sessionTitle: string | null;
    project: string;
    repoRoot: string;
    cwd: string;
    isWorktree: boolean;
    worktreePath: string | null;
    branch: string | null;
    commitSha: string | null;
    commitMessage: string | null;
}
