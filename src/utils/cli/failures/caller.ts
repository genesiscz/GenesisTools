import type { AgentRuntimeContext } from "@genesiscz/utils/agent/context";
import { callerModelOf, callerTranscriptOf, hostLabel } from "@genesiscz/utils/agent/identity";
import { profiler } from "@genesiscz/utils/profile";
import type { FailureCaller } from "./record";

export { claudeProjectFolder } from "@genesiscz/utils/agent-sessions/readers/claude-locate";

const prof = profiler.scope("agent-context");

export interface CallerInputs {
    context: AgentRuntimeContext;
    processEnv: NodeJS.ProcessEnv;
    now?: Date;
    home?: string;
}

/**
 * The transcript of the calling session, when this machine has it: the agent identity module's transcript lookup,
 * which each harness's locator answers from the caller's own env and cwd (Claude by its project folder, Codex in the
 * first `CODEX_HOME` entry and the last seven days, Grok by its cwd folder; Copilot and an unknown caller have none).
 */
export function transcriptOf({ context, processEnv, now = new Date(), home }: CallerInputs): string | null {
    return callerTranscriptOf({
        agent: context.agent,
        sessionId: context.sessionId,
        env: processEnv,
        cwds: [context.cwd, context.repoRoot],
        now,
        home,
    });
}

export function failureCaller(inputs: CallerInputs): FailureCaller {
    return prof.measure("failures.failureCaller", () => readFailureCaller(inputs));
}

function readFailureCaller(inputs: CallerInputs): FailureCaller {
    const { context, processEnv } = inputs;
    const transcript = transcriptOf(inputs);

    return {
        agent: context.agent,
        sessionId: context.sessionId,
        sessionTitle: context.sessionTitle,
        model: callerModelOf(context.agent, transcript),
        effort: processEnv.CLAUDE_EFFORT?.trim() || null,
        // The label of a host that takes one: Codex sets none, so an AI_AGENT in its env is an outer host's.
        aiAgent: context.aiAgent ?? hostLabel(context.agent, processEnv),
        project: context.project,
        repoRoot: context.repoRoot,
        cwd: context.cwd,
        branch: context.branch,
        commitSha: context.commitSha,
        worktreePath: context.worktreePath,
    };
}
