import { basename, resolve } from "node:path";
import { getSessionMetadataBySessionId } from "@app/claude/lib/history/cache";
import { logger } from "@app/logger";
import { detectCurrentProject } from "@app/utils/claude/projects";
import { type AgentRuntimeContext, resolveClaudeContext } from "@app/utils/claude/runtime-context";
import { isCodex, resolveCodexContext } from "@app/utils/codex/runtime-context";
import { env as appEnv } from "@app/utils/env";
import { getMainRepoRootSync } from "@app/utils/git/worktree";

export type { AgentRuntimeContext } from "@app/utils/claude/runtime-context";

function gitSync(args: string[], cwd: string): string | null {
    const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    if (r.exitCode !== 0) {
        return null;
    }

    const out = r.stdout.toString().trim();
    return out.length > 0 ? out : null;
}

export function getAgentRuntimeContext(
    overrides: Partial<AgentRuntimeContext> = {},
    processEnv: NodeJS.ProcessEnv = appEnv.getProcessEnv()
): AgentRuntimeContext {
    const cwd = overrides.cwd ?? process.cwd();
    const repoRoot = (() => {
        try {
            return getMainRepoRootSync(cwd);
        } catch {
            return cwd;
        }
    })();

    let agentPartial: Partial<AgentRuntimeContext> = { agent: "unknown", sessionId: null, isInAgent: false };
    if (processEnv.CLAUDE_CODE_SESSION_ID || processEnv.CLAUDECODE) {
        agentPartial = resolveClaudeContext(processEnv);
    } else if (isCodex(processEnv)) {
        agentPartial = resolveCodexContext(processEnv);
    }

    // Canonical worktree test: in the main repo `--git-dir` and
    // `--git-common-dir` resolve to the same path; in a linked worktree the
    // git-dir is `.../.git/worktrees/<name>` while the common-dir is the main
    // `.git`, so they differ. The old `endsWith(${repoRoot}/.git)` guard was
    // always false inside a worktree because repoRoot already pointed at the
    // main root — `isWorktree` could never be true (t23).
    const gitDir = gitSync(["rev-parse", "--git-dir"], cwd);
    const gitCommonDir = gitSync(["rev-parse", "--git-common-dir"], cwd);
    const isWorktree = gitDir != null && gitCommonDir != null && resolve(cwd, gitDir) !== resolve(cwd, gitCommonDir);
    const base: AgentRuntimeContext = {
        agent: "unknown",
        sessionId: null,
        isInAgent: false,
        aiAgent: processEnv.AI_AGENT ?? null,
        sessionTitle: null,
        project: detectCurrentProject() ?? basename(repoRoot),
        repoRoot,
        cwd,
        isWorktree,
        worktreePath: isWorktree ? gitSync(["rev-parse", "--show-toplevel"], cwd) : null,
        branch: gitSync(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
        commitSha: gitSync(["rev-parse", "--short", "HEAD"], cwd),
        commitMessage: gitSync(["log", "-1", "--format=%s"], cwd),
    };

    const merged = { ...base, ...agentPartial, ...overrides };

    if (!merged.sessionTitle && merged.agent === "claude-code" && merged.sessionId) {
        try {
            const meta = getSessionMetadataBySessionId(merged.sessionId);
            merged.sessionTitle = meta?.customTitle ?? meta?.summary ?? null;
        } catch (error) {
            // History index is optional — log so a missing/corrupt index is diagnosable.
            logger.debug(
                { error, sessionId: merged.sessionId },
                "agent-runtime: failed to backfill claude session title"
            );
        }
    }

    return merged;
}
