import type { AgentRuntimeContext } from "@genesiscz/utils/agent/context";
import {
    type AgentIdentity,
    type IdentityFacet,
    toRuntimeContext,
    whoIsCalling,
} from "@genesiscz/utils/agent/identity";
import { profiler } from "@genesiscz/utils/profile";
import type { FailureCaller } from "./record";

export { claudeProjectFolder } from "@genesiscz/utils/agent-sessions/readers/claude-locate";

const prof = profiler.scope("agent-context");

/** The facts a failure record keeps: the live folder, its git facts, the title, and the model from the transcript. */
const FAILURE_FACETS = ["cwd", "git", "title", "model"] as const satisfies readonly IdentityFacet[];

export interface CallerInputs {
    /** The caller's environment: the agent identity module reads the host, the session and the effort from it. */
    processEnv: NodeJS.ProcessEnv;
    /** Facts the caller already knows. The identity module takes them as given and never reads them again. */
    context?: Partial<AgentRuntimeContext>;
    now?: Date;
    home?: string;
}

/**
 * The transcript of the calling session, when this machine has it: the identity module's `transcript` facet, which
 * each harness's locator answers from the caller's own env and cwd (Claude by its project folder, Codex in the
 * first `CODEX_HOME` entry and the last seven days, Grok by its cwd folder; Copilot and an unknown caller have none).
 */
export function transcriptOf({ processEnv, context, now = new Date(), home }: CallerInputs): string | null {
    const identity = whoIsCalling(
        { origin: "local", env: processEnv },
        { overrides: context, facets: ["transcript"], now, home }
    );
    return identity.transcriptPath ?? null;
}

/** Who ran the tool, as a failure record keeps it: the agent identity, with the model and effort the identity gives. */
export function failureCaller(inputs: CallerInputs): FailureCaller {
    return prof.measure("failures.failureCaller", () => {
        const { processEnv, context, now = new Date(), home } = inputs;
        return failureCallerOf(
            whoIsCalling(
                { origin: "local", env: processEnv },
                { overrides: context, facets: FAILURE_FACETS, now, home }
            )
        );
    });
}

/** A pick of the identity: the record keeps its shape, and a fact the identity lacks is null, never guessed. */
export function failureCallerOf(identity: AgentIdentity): FailureCaller {
    const context = toRuntimeContext(identity);

    return {
        agent: context.agent,
        sessionId: context.sessionId,
        sessionTitle: context.sessionTitle,
        model: identity.model ?? null,
        effort: identity.effort ?? null,
        aiAgent: context.aiAgent,
        project: context.project,
        repoRoot: context.repoRoot,
        cwd: context.cwd,
        branch: context.branch,
        commitSha: context.commitSha,
        worktreePath: context.worktreePath,
    };
}
