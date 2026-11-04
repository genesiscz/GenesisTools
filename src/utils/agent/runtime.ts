import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentRuntimeContext } from "@genesiscz/utils/agent/context";
import {
    type CallerInput,
    gitCommonRoot as identityGitCommonRoot,
    toRuntimeContext,
    whoIsCalling,
} from "@genesiscz/utils/agent/identity";
import { env as appEnv } from "@genesiscz/utils/env";
import { profiler } from "@genesiscz/utils/profile";

export type { AgentRuntimeContext } from "@genesiscz/utils/agent/context";

const prof = profiler.scope("agent-context");

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
    sourceMessage?: AgentRuntimeContext["sourceMessage"];
    agent: AgentRuntimeContext["agent"];
    sessionId: string | null;
    /** The caller's live cwd. Null means the caller has none: its stamps get no cwd and no git facts, never this server's. */
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

/**
 * Absolute, CANONICAL path of the shared `.git`; every worktree of one repo returns the same value. The identity
 * module owns it (and caches the layout per cwd); this name stays for its callers.
 */
export function gitCommonRoot(cwd: string): string | null {
    return identityGitCommonRoot(cwd);
}

/**
 * Who this process works for, with its checkout: a thin adapter over `whoIsCalling` with the `cwd`, `git` and `title`
 * facets. Inside a request scope (`runAsCaller`) the scoped caller replaces the process env and cwd completely.
 */
export function getAgentRuntimeContext(
    overrides: Partial<AgentRuntimeContext> = {},
    processEnv: NodeJS.ProcessEnv = appEnv.getProcessEnv()
): AgentRuntimeContext {
    return prof.measure("runtime.getAgentRuntimeContext", () => {
        const caller = callerScope.getStore();
        const input: CallerInput = caller ? { origin: "remote", caller } : { origin: "local", env: processEnv };
        return toRuntimeContext(whoIsCalling(input, { facets: RUNTIME_FACETS, overrides }));
    });
}

const RUNTIME_FACETS = ["cwd", "git", "title"] as const;
