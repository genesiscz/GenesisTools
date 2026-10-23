/** The files folded or opened against their default: `<row>|<call>|<path>`, the newest 500. */
export type FlippedFiles = string[];

/** The git-sync calls whose hidden diff the person opened: `<row>|<call>`, the newest 500. */
export type ShownCalls = string[];

/** One option of a decision: its letter and its text. */
export interface DecisionOption {
    letter: string;
    text: string;
}

/** A `❓ DECISION N` the assistant asked and nobody answered or replaced yet. */
export interface OpenDecision {
    n: number;
    title: string;
    options: DecisionOption[];
}

/** The open decisions `/decisions` lists, as last read from the session's messages. */
export type OpenDecisions = OpenDecision[];

/** What the person staged per decision number: `a)` for an option, or their own words. */
export type StagedDecisions = Record<string, string>;

/** One CI check of a pull request. */
export interface BandCheck {
    name: string;
    verdict: "pass" | "fail" | "pending";
}

/** One pull request the git band shows. */
export interface BandPr {
    number: number;
    title: string;
    url: string;
    state: string;
    draft: boolean;
    passed: number;
    failed: number;
    pending: number;
    checks: BandCheck[];
    tracked: boolean;
}

/** The git band's line, as the last refresh found it. */
export interface GitBand {
    at: number;
    branch: string;
    ahead: number;
    behind: number;
    dirty: number;
    prs: BandPr[];
}

/** The git band of this session: `null` until the first refresh. */
export type GitBandLine = GitBand | null;

/** `/mod-git on|off` for this session; `null` follows `mods.git.enabled`. */
export type GitBandSwitch = boolean | null;

/** One session whose prompt cache runs out soon, as the cache band shows it. */
export interface CacheRow {
    sessionId: string;
    label: string;
    expiresAt: number;
    own: boolean;
}

/** The rows of the cache band: this session's, then other sessions under the warning threshold. */
export type CacheRows = CacheRow[];

/** The last /tmp reading: KB of this session's scratch folder and free KB on the system disk. */
export interface TmpReading {
    at: number;
    sessionKb: number | null;
    freeKb: number | null;
}

export type TmpUsage = TmpReading | null;

/** A subagent this session spawned, as `agent.spawn` answered: its model, what it was for, when it started. */
export interface SpawnedAgent {
    model: string;
    description: string;
    at: number;
}

export type SpawnedAgents = Record<string, SpawnedAgent>;

/** What the hooks handed the model, per loop (`main` or a subagent id summed as `agents`). */
export interface HookCount {
    fires: number;
    chars: number;
}

/** The hook ledger: what settings hooks injected this session, and what the dedupe dropped as a repeat. */
export interface HookLedger {
    main: HookCount;
    agents: HookCount;
    byEvent: Record<string, HookCount>;
    dropped: HookCount;
}

declare module "claude-code" {
    interface PluginState {
        "genesis-tools-mods": {
            flipped: FlippedFiles;
            shown: ShownCalls;
        };
    }
}
