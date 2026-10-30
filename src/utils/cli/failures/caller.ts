import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentRuntimeContext } from "@genesiscz/utils/agent/context";
import { harnessHooks } from "@genesiscz/utils/ai/providers/harness-hooks";
import { harnessOfRuntimeAgent } from "@genesiscz/utils/ai/providers/harness-index";
import { defaultNativeHome, parseCodexHomeList } from "@genesiscz/utils/providers/session-paths";
import type { FailureCaller } from "./record";

const CODEX_DAYS_BACK = 7;

/** Claude names a project folder after the session's cwd with every non-alphanumeric character as `-`. */
export function claudeProjectFolder(cwd: string): string {
    return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

function claudeTranscript(sessionId: string, cwds: string[], configDir: string): string | null {
    const projects = join(configDir, "projects");
    const file = `${sessionId}.jsonl`;

    for (const cwd of cwds) {
        const direct = join(projects, claudeProjectFolder(cwd), file);
        if (existsSync(direct)) {
            return direct;
        }
    }

    if (!existsSync(projects)) {
        return null;
    }

    for (const folder of readdirSync(projects)) {
        const candidate = join(projects, folder, file);
        if (existsSync(candidate)) {
            return candidate;
        }
    }

    return null;
}

function codexRollout(threadId: string, codexHome: string, now: Date): string | null {
    for (let back = 0; back < CODEX_DAYS_BACK; back++) {
        const day = new Date(now.getTime() - back * 86_400_000);
        const dir = join(
            codexHome,
            "sessions",
            String(day.getFullYear()),
            String(day.getMonth() + 1).padStart(2, "0"),
            String(day.getDate()).padStart(2, "0")
        );
        if (!existsSync(dir)) {
            continue;
        }

        // Codex 0.164 compresses old rollouts to `.jsonl.zst`; the model read takes either form.
        const name = readdirSync(dir).find(
            (entry) => entry.endsWith(`-${threadId}.jsonl`) || entry.endsWith(`-${threadId}.jsonl.zst`)
        );
        if (name) {
            return join(dir, name);
        }
    }

    return null;
}

export interface CallerInputs {
    context: AgentRuntimeContext;
    processEnv: NodeJS.ProcessEnv;
    now?: Date;
    home?: string;
}

/** The transcript of the calling session, when this machine has it. */
export function transcriptOf({ context, processEnv, now = new Date(), home }: CallerInputs): string | null {
    if (!context.sessionId) {
        return null;
    }

    return CALLER_TRANSCRIPTS[context.agent]({ context, processEnv, now, home }, context.sessionId);
}

/** Where each calling harness keeps the transcript of a session; Grok and Copilot sessions are not looked up. */
const CALLER_TRANSCRIPTS: Record<
    AgentRuntimeContext["agent"],
    (inputs: CallerInputs & { now: Date }, sessionId: string) => string | null
> = {
    "claude-code": ({ context, processEnv, home }, sessionId) => {
        const configDir = processEnv.CLAUDE_CONFIG_DIR?.trim() || defaultNativeHome("claude", home);
        return claudeTranscript(sessionId, [context.cwd, context.repoRoot], configDir);
    },
    codex: ({ processEnv, now, home }, sessionId) => {
        // The caller's CODEX_HOME is a comma list; its Codex writes rollouts to the first entry.
        const codexHome = parseCodexHomeList(processEnv.CODEX_HOME)[0] ?? defaultNativeHome("codex", home);
        return codexRollout(sessionId, codexHome, now);
    },
    grok: () => null,
    copilot: () => null,
    unknown: () => null,
};

export function failureCaller(inputs: CallerInputs): FailureCaller {
    const { context, processEnv } = inputs;
    const transcript = transcriptOf(inputs);
    const harness = harnessOfRuntimeAgent(context.agent);
    const model = transcript && harness ? harnessHooks(harness).currentModel(transcript) : null;

    return {
        agent: context.agent,
        sessionId: context.sessionId,
        sessionTitle: context.sessionTitle,
        model,
        effort: processEnv.CLAUDE_EFFORT?.trim() || null,
        aiAgent: context.aiAgent ?? (processEnv.AI_AGENT?.trim() || null),
        project: context.project,
        repoRoot: context.repoRoot,
        branch: context.branch,
        commitSha: context.commitSha,
        worktreePath: context.worktreePath,
    };
}
