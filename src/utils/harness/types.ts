import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import type { HarnessPartContracts } from "./parts";

/**
 * A coding agent this repo drives (Claude Code, Codex, Grok). It is `AccountProviderAlias`, not a second name type:
 * the alias list in `src/utils/ai/providers/alias-list.ts` stays the one list, and the registry of drivers is
 * `ProviderPlugin.harness` (`plugin-types.ts`), reached through the provider registry. See the plan
 * `.claude/plans/2026-10-30-PlugenizeHarnesses.md`.
 */
export type HarnessId = AccountProviderAlias;

export type Lazy<T> = () => Promise<T>;

/** The phases of the plan that move a part into its driver. */
export type HarnessPhase = "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7";

/**
 * Parts implemented in `@genesiscz/utils` whose contract is written in the phase that moves them (plan section 3):
 * `live` (P2), `hooks`, `statusline` (P4), `compaction` (P5). Until then a driver can only declare them pending.
 */
export type PendingContractPart = "live" | "hooks" | "statusline" | "compaction";

/**
 * Parts whose implementation lives in a tool, so the shared package can never import it: cmux capture and restore
 * (`src/cmux`), answer delivery (`src/question`), the worker drivers (`src/claude`, `src/codex`, `src/grok`), spend
 * (`src/ai-spend`), MCP config (`src/mcp-manager`), the subagent tree (`src/hub`). The driver names the tool module
 * that owns the part's exhaustive table keyed by `HarnessId` (`toolOwned`).
 */
export type ToolOwnedPart = "cmux" | "answer" | "worker" | "spend" | "mcp" | "subagents";

export type HarnessPartName = keyof HarnessPartContracts | PendingContractPart | ToolOwnedPart;

/** Every part, in the order of the inventory sections (plan section 1). */
export const HARNESS_PARTS = [
    "locate",
    "parse",
    "turnState",
    "questions",
    "live",
    "launch",
    "exit",
    "hooks",
    "statusline",
    "spend",
    "compaction",
    "cmux",
    "process",
    "host",
    "worker",
    "answer",
    "mcp",
    "history",
    "subagents",
] as const satisfies readonly HarnessPartName[];

/** Why a driver does not carry a part's implementation itself. Every variant carries a reason a person can read. */
export type PartNote =
    /** The harness cannot have the part ("Codex rollouts do not persist approval requests"). */
    | { readonly kind: "unsupported"; readonly reason: string }
    /** The part still lives at its old sites; `phase` moves it here. */
    | { readonly kind: "pending"; readonly phase: HarnessPhase; readonly reason: string }
    /** A tool owns the part; `owner` is the repo-relative module with the table keyed by `HarnessId`. */
    | { readonly kind: "tool-owned"; readonly owner: string; readonly reason: string };

export type PartSlot<T> = Lazy<T> | PartNote;

/**
 * Every part is a required key, so the compiler names each driver that says nothing about a part. A part with a
 * contract is a lazy loader or a note; a part without one can only be a note.
 */
export type HarnessParts = { readonly [P in keyof HarnessPartContracts]: PartSlot<HarnessPartContracts[P]> } & {
    readonly [P in PendingContractPart | ToolOwnedPart]: PartNote;
};

/** Static facts about a harness. Plain data, so reading identity never loads a part. */
export interface HarnessIdentity {
    /** "Claude Code", "Codex", "Grok". */
    readonly label: string;
    /** The executable a user starts. */
    readonly binary: string;
    /** Other spellings a user or another tool writes for the harness ("claude-code", "codex-cli"). */
    readonly aliases: readonly string[];
}

/**
 * One coding agent's driver. It hangs off its provider plugin (`ProviderPlugin.harness`), so the provider registry
 * stays the only registry; the parts are lazy, so a caller that needs one part loads only that part.
 */
export interface HarnessDriver<Id extends HarnessId = HarnessId> {
    readonly id: Id;
    readonly identity: HarnessIdentity;
    readonly parts: HarnessParts;
}

export function unsupported(reason: string): PartNote {
    return { kind: "unsupported", reason };
}

export function pending(phase: HarnessPhase, reason: string): PartNote {
    return { kind: "pending", phase, reason };
}

export function toolOwned(owner: string, reason: string): PartNote {
    return { kind: "tool-owned", owner, reason };
}

export function isPartNote<T>(slot: PartSlot<T>): slot is PartNote {
    return typeof slot !== "function";
}
