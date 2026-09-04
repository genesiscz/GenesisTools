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

/** The agents `monitor` knows how to read. */
export type AgentId = "claude" | "codex" | "grok";

export const AGENT_IDS: readonly AgentId[] = ["claude", "codex", "grok"];

/**
 * The provider plugin that owns each agent's accounts.
 *
 * An agent is a transcript dialect; a plugin is a login. They are one-to-one
 * today and this map is the only place that says so, so a driver never hardcodes
 * a plugin id and the accounts wiring never hardcodes an agent id.
 */
export const AGENT_PLUGIN_IDS: Record<AgentId, string> = {
    claude: "anthropic-sub",
    codex: "openai-sub",
    grok: "grok-sub",
};

export interface DriverUsageEvent {
    /**
     * Dedup key, unique within one transcript. Agents that stamp a message or
     * event id use it verbatim; the rest synthesize one from the fields that
     * make a request unique (timestamp, model, token counts).
     */
    id: string;
    model: string;
    /** ISO-8601 timestamp. "" when the line carried none (the event is dropped). */
    timestamp: string;
    /** Billable, NON-cached input tokens (cache reads/writes are separate below). */
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    /** Subset of outputTokens. Codex/Grok report it; never added on top of output. */
    reasoningOutputTokens?: number;
    /**
     * Cost in USD that the agent itself recorded for this event. Authoritative
     * when present: Grok prices each API request separately and only reports
     * the per-turn sum, so recomputing from the summed tokens cannot land on
     * the same figure. Absent means "derive it from the catalog rates".
     */
    recordedCostUsd?: number;
}

/**
 * A parser bound to ONE transcript. Codex carries state across lines (the
 * sticky `turn_context` model, the previous cumulative totals), and the
 * incremental cache resumes a file mid-way, so that state has to survive
 * between runs — hence `snapshot()`, which is persisted next to the file's
 * byte offset and handed back on the next run.
 */
export interface DriverLineParser {
    /**
     * Emit every usage event on this line. One line can bill several models
     * (Grok's per-turn `modelUsage` map), and most lines bill none, so events
     * are pushed rather than returned — no array is allocated for the common
     * case of a line that carries no usage at all.
     */
    parseLine(line: string, emit: (event: DriverUsageEvent) => void): void;
    /** JSON-serializable resume state, or undefined for stateless drivers. */
    snapshot(): unknown;
}

export interface CreateParserOptions {
    /** Absolute path of the transcript being parsed (siblings, session ids). */
    file: string;
    /** Whatever `snapshot()` returned last run, or undefined on a fresh parse. */
    state: unknown;
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
}
