/**
 * Start or relaunch an agent from the phone (F21). Types only (`contract-purity.test.ts`). The options come from
 * `tools hub launch` (`/api/gateway/launch`): every harness with its enabled accounts ranked by headroom from the
 * usage cache (never a fetch, so no refresh token is spent), and the project folders. The start runs
 * `tools cmux agents new` on the Mac (`POST /api/agents/new`).
 */

/** The ranker's tiers, best first (`RankTier` in `@genesiscz/utils/ai/providers/usage-rank`). */
export type LaunchTierDto = "ready" | "session-starved" | "weekly-blocked" | "no-data";

export interface LaunchAccountDto {
    id: string;
    name: string;
    tier: LaunchTierDto;
    /** Percent left in the 5-hour window; null without a reading or without such a window. */
    sessionLeftPct: number | null;
    /** Percent left in the weekly or monthly window; null without a reading. */
    longLeftPct: number | null;
    /** Live sessions that already run on the account. */
    sessions: number;
    /** The ranker's one-line reason. */
    why: string;
}

export interface LaunchAgentDto {
    /** The harness id `tools cmux agents new` takes: `claude`, `codex`, `grok`. */
    id: string;
    /** Accounts best first; the first `ready` or `session-starved` one is the suggestion. */
    accounts: LaunchAccountDto[];
}

export interface LaunchOptionsDto {
    generatedAt: string;
    agents: LaunchAgentDto[];
    /** Project folder names, most recently changed first. */
    repos: string[];
}

export interface AgentNewInput {
    agent: string;
    repo: string;
    account: string;
    prompt?: string;
    name?: string;
    model?: string;
}

export interface AgentNewReceiptDto {
    started: boolean;
    /** The session record's name (`tools cmux agents list`). */
    name: string | null;
    workspace: string | null;
    cwd: string | null;
    /** Why it did not start: the tool's own error line. */
    error: string | null;
}
