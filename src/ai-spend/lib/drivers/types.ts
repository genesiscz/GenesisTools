/**
 * `ai-spend monitor` reads more than one coding agent. Every agent writes its
 * own JSONL dialect in its own directory tree, so the walker, the mtime
 * pruning, the incremental tail cache and the 10-minute sweep live ONCE in
 * `monitor.ts`, and each agent contributes only the three things that actually
 * differ: where its transcripts live, which file names count, and how one line
 * turns into a usage event.
 *
 * Line shapes and token semantics mirror ccusage's Rust adapters
 * (`rust/adapters/{claude,codex,grok}` in the ccusage repo) so the numbers line
 * up with what ccusage reports for the same files.
 */

import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { ACCOUNT_PROVIDER_ALIASES, type AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { harnessPluginId } from "@genesiscz/utils/ai/providers/harness-index";
import type { CreateParserOptions, DriverLineParser } from "@genesiscz/utils/ai/usage/transcripts/types";

export type {
    CreateParserOptions,
    DriverLineParser,
    DriverUsageEvent,
} from "@genesiscz/utils/ai/usage/transcripts/types";

/** The agents `monitor` knows how to read. */
export type AgentId = AccountProviderAlias;

export const AGENT_IDS: readonly AgentId[] = ACCOUNT_PROVIDER_ALIASES;

/**
 * One value per agent: a data container (the monitor's per-agent totals and cache, the homes `--all-homes` found),
 * built by `byHarness` or filled by a loop over `AGENT_IDS`. It names no agent, so a new harness needs no edit here.
 */
export type ByAgent<T> = { [Id in AgentId]: T };

/**
 * The provider plugin that owns an agent's accounts. An agent is a transcript dialect; a plugin is a login. The
 * harness driver names its plugin (`identity.plugin`), so a driver never hardcodes a plugin id and the accounts wiring
 * never hardcodes an agent id.
 */
export function agentPluginId(agent: AgentId): string {
    return harnessPluginId(agent);
}

/**
 * One tree to walk, plus who it belongs to.
 *
 * `accountId` absent means nobody claims it: the default roots, and any home
 * `discoverHomes` turned up that no account references. Those events report
 * under `UNBOUND_ACCOUNT_ID` rather than being dropped — a home that is not
 * bound yet still cost money.
 */
export interface DriverRoot {
    path: string;
    /** `AccountEntry.id`. Absent for an unbound root. */
    accountId?: string;
    /** The provider home this root hangs off (`~/.codex-work`), when known. */
    home?: string;
}

export interface MonitorDriver {
    id: AgentId;
    /** Directory trees to walk. Missing directories are skipped, not an error. */
    roots(home: string): string[];
    /**
     * The same trees, split per account, via `plugin.accounts.spendScope`.
     * Absent means this agent cannot attribute transcripts to an account, so
     * every root stays unbound.
     *
     * `userHome` is the same home `roots()` got. A provider whose accounts share
     * ONE tree (anthropic) needs it to stay inside that home: its `spendScope`
     * answers for the real `$HOME`, and without this argument an injected home
     * would silently pull the real `~/.claude/projects` in beside it.
     */
    rootsForAccounts?(accounts: AccountEntry[], userHome: string): DriverRoot[];
    /** File-name test, applied BEFORE stat() so non-transcripts cost nothing. */
    isTranscript(name: string): boolean;
    /** How deep below a root transcripts can sit. */
    maxDepth: number;
    createParser(options: CreateParserOptions): DriverLineParser;
    /**
     * Pricing-table keys to try for a raw model id, most specific first. An id
     * that matches nothing is unpriced and costs $0 — never a guessed rate.
     */
    priceCandidates(model: string): string[];
    /**
     * The one account row all of the agent's spend lands in, when its transcripts record no login; null when each
     * transcript home belongs to its own account. Claude's `~/.claude/projects` names no account (decision D6), so
     * its spend is the synthetic "claude (all accounts)" row and the per-account split lives in the call log.
     */
    sharedAccountRow: string | null;
    /**
     * The id ai-spend keys a headless worker session's usage by, from the worker's native session id (`home` is the
     * worker's provider home, when known); null when the transcript that names it is not on disk.
     */
    spendSessionId(sessionId: string, home: string | null | undefined): string | null;
}
