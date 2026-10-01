import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { AgentRuntimeContext } from "@genesiscz/utils/agent/context";
import { resolveAgentHost } from "@genesiscz/utils/agent/host";
import { readCachedHistoryTitle } from "@genesiscz/utils/agent-sessions/cached-title";
import { PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/aliases";
import { env as appEnv } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { resolveAncestorCwd } from "@genesiscz/utils/process/cwd";

export type { AgentRuntimeContext } from "@genesiscz/utils/agent/context";

/**
 * The harness session a request came from, when this process serves many sessions.
 *
 * A stdio MCP server is spawned by one session and reads that session from its own env
 * and cwd. A resident server (the mcp-manager gateway) is spawned by launchd, so its env
 * and cwd describe nobody: it learns the caller per request and runs the handler inside
 * this scope. Inside the scope the caller wins over the process env and cwd; outside it
 * nothing changes.
 */
export interface AgentCaller {
    agent: AgentRuntimeContext["agent"];
    sessionId: string | null;
    /** The caller's live cwd. Null leaves the process's own answer in place. */
    cwd: string | null;
}

const callerScope = new AsyncLocalStorage<AgentCaller>();

export function runAsCaller<T>(caller: AgentCaller, fn: () => T): T {
    return callerScope.run(caller, fn);
}

export function currentCaller(): AgentCaller | undefined {
    return callerScope.getStore();
}

/** Where relative paths resolve for the current request: the caller's cwd, else this process's. */
export function callerCwd(): string {
    return callerScope.getStore()?.cwd ?? process.cwd();
}

function gitSync(args: string[], cwd: string): string | null {
    const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    if (r.exitCode !== 0) {
        return null;
    }

    const out = r.stdout.toString().trim();
    return out.length > 0 ? out : null;
}

/**
 * Absolute, CANONICAL path of the shared `.git`. Every worktree of one repo
 * returns the same value.
 *
 * realpath, not just resolve (PR #343 review t1 round 13). `resolveAncestorCwd`
 * canonicalises its paths on purpose, because the kernel reports
 * `/private/tmp/...` where `process.cwd()` keeps `/tmp/...`. Comparing a lexical
 * common-dir against a canonical one made the SAME repository reached through a
 * symlink produce two unequal strings, which rejected the live ancestor cwd and
 * reinstated the stale-cwd bug this resolution exists to fix.
 */
export function gitCommonRoot(cwd: string): string | null {
    const common = gitSync(["rev-parse", "--git-common-dir"], cwd);

    if (!common) {
        return null;
    }

    const absolute = resolve(cwd, common);

    try {
        return realpathSync(absolute);
    } catch {
        // Not yet on disk (a pruned worktree, a race): the lexical form is still
        // a usable comparison key, and both sides go through this same fallback.
        return absolute;
    }
}

/**
 * The directory the SESSION is in, which is not always ours.
 *
 * `process.cwd()` is fixed at spawn. An MCP server starts with the session and
 * keeps that first directory forever, so after the session moves (EnterWorktree)
 * every git fact read here comes from the wrong checkout. On 2026-08-29 a Q→A
 * was filed against `ci/aws-secrets-injection` while the session sat in a
 * worktree on `feat/notification-templates-#202`.
 *
 * The host process does chdir, so the nearest ancestor with a different cwd is
 * the live answer. It is accepted only when it shares our `.git`, so a terminal
 * emulator sitting in `~` can never be mistaken for the session.
 */
function resolveSessionCwd(): string {
    const own = process.cwd();
    const candidate = resolveAncestorCwd({ ownCwd: own });
    if (!candidate) {
        return own;
    }

    const ownRepo = gitCommonRoot(own);
    if (!ownRepo || ownRepo !== gitCommonRoot(candidate)) {
        logger.debug({ own, candidate }, "agent-runtime: ancestor cwd is a different repo, keeping process.cwd()");
        return own;
    }

    logger.debug({ own, candidate }, "agent-runtime: adopting the host process cwd");
    return candidate;
}

export function getAgentRuntimeContext(
    overrides: Partial<AgentRuntimeContext> = {},
    processEnv: NodeJS.ProcessEnv = appEnv.getProcessEnv()
): AgentRuntimeContext {
    const caller = callerScope.getStore();
    const cwd = overrides.cwd ?? caller?.cwd ?? resolveSessionCwd();

    const agentPartial: Partial<AgentRuntimeContext> = caller
        ? { agent: caller.agent, sessionId: caller.sessionId, isInAgent: caller.agent !== "unknown", aiAgent: null }
        : resolveAgentHost(processEnv);

    // Canonical worktree test: in the main repo `--git-dir` and
    // `--git-common-dir` resolve to the same path; in a linked worktree the
    // git-dir is `.../.git/worktrees/<name>` while the common-dir is the main
    // `.git`, so they differ. The old `endsWith(${repoRoot}/.git)` guard was
    // always false inside a worktree because repoRoot already pointed at the
    // main root — `isWorktree` could never be true (t23).
    const gitDir = gitSync(["rev-parse", "--git-dir"], cwd);
    const gitCommonDir = gitSync(["rev-parse", "--git-common-dir"], cwd);
    const isWorktree = gitDir != null && gitCommonDir != null && resolve(cwd, gitDir) !== resolve(cwd, gitCommonDir);
    const topLevel = gitSync(["rev-parse", "--show-toplevel"], cwd);
    // A linked worktree's main repo is the parent of the shared `.git`; anywhere
    // else it is the checkout root. Taking `cwd` verbatim named the project after
    // whatever subdirectory the session happened to be in.
    const repoRoot = isWorktree && gitCommonDir ? resolve(cwd, gitCommonDir, "..") : (topLevel ?? cwd);
    const base: AgentRuntimeContext = {
        agent: "unknown",
        sessionId: null,
        isInAgent: false,
        aiAgent: processEnv.AI_AGENT ?? null,
        sessionTitle: null,
        project: basename(repoRoot),
        repoRoot,
        cwd,
        isWorktree,
        worktreePath: isWorktree ? topLevel : null,
        branch: gitSync(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
        commitSha: gitSync(["rev-parse", "--short", "HEAD"], cwd),
        commitMessage: gitSync(["log", "-1", "--format=%s"], cwd),
    };

    const merged = { ...base, ...agentPartial, ...overrides };

    const historyProvider = PROVIDER_ALIASES[merged.agent === "claude-code" ? "claude" : merged.agent];

    if (!merged.sessionTitle && historyProvider && merged.sessionId) {
        try {
            const meta = readCachedHistoryTitle({ providerId: historyProvider, sessionId: merged.sessionId });
            merged.sessionTitle = meta?.customTitle ?? meta?.summary ?? null;
        } catch (error) {
            // History index is optional — log so a missing/corrupt index is diagnosable.
            logger.debug(
                { error, sessionId: merged.sessionId },
                "agent-runtime: failed to backfill cached session title"
            );
        }
    }

    return merged;
}

/**
 * The one poster stamp for anything a harness posts: handoffs, questions, decisions.
 * Callers pass overrides and an env only in tests. Production reads the live process.
 */
export function gatherHarnessPoster(
    overrides: Partial<AgentRuntimeContext> = {},
    processEnv?: NodeJS.ProcessEnv
): AgentRuntimeContext {
    if (processEnv === undefined) {
        return getAgentRuntimeContext(overrides);
    }

    return getAgentRuntimeContext(overrides, processEnv);
}
