import type { HarnessId } from "@genesiscz/utils/harness/types";
import type { SourceMessage } from "./source-anchor";

/** Who a caller is: Claude is `claude-code`, the other harnesses keep their id, Copilot is a host but no harness. */
export type CallerAgent = "claude-code" | Exclude<HarnessId, "claude"> | "copilot" | "unknown";

/**
 * The two facts every shape of a caller shares: its runtime agent and its session. The identity (`AgentIdentity`), the
 * runtime context, a request scope, a peer answer and the failure record all extend it, so a change of the agent axis
 * is one edit here.
 */
export interface CallerCore {
    agent: CallerAgent;
    sessionId: string | null;
}

/**
 * A caller a request already resolved (the gateway's `runAsCaller` scope): the core, its live cwd and its anchor. A
 * null cwd means the caller has none: its stamps get no cwd and no git facts, never the server's own.
 */
export interface ScopedCaller extends CallerCore {
    cwd: string | null;
    sourceMessage?: SourceMessage;
}

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
export interface AgentRuntimeContext extends CallerCore {
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
