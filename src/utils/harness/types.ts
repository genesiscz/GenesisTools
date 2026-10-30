import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import type { EagerPartContracts, HarnessPartContracts, LazyPartContracts } from "./parts";

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
export type ToolOwnedPart = "cmux" | "answer" | "spend" | "mcp" | "subagents";

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
    "transcript",
] as const satisfies readonly HarnessPartName[];

/** Why a driver does not carry a part's implementation itself. Every variant carries a reason a person can read. */
export type PartNote =
    /** The harness cannot have the part ("Codex rollouts do not persist approval requests"). */
    | { readonly note: true; readonly kind: "unsupported"; readonly reason: string }
    /** The part still lives at its old sites; `phase` moves it here. */
    | { readonly note: true; readonly kind: "pending"; readonly phase: HarnessPhase; readonly reason: string }
    /** A tool owns the part; `owner` is the repo-relative module with the table keyed by `HarnessId`. */
    | { readonly note: true; readonly kind: "tool-owned"; readonly owner: string; readonly reason: string };

/** A lazy part: a loader, or a note. */
export type PartSlot<T> = Lazy<T> | PartNote;
/** An eager part: the value itself, or a note (`note: true` tells them apart). */
export type EagerSlot<T> = T | PartNote;

/**
 * Every part is a required key, so the compiler names each driver that says nothing about a part. A part with a
 * contract is a lazy loader or a note; a part without one can only be a note.
 */
export type HarnessParts = { readonly [P in keyof LazyPartContracts]: PartSlot<LazyPartContracts[P]> } & {
    readonly [P in keyof EagerPartContracts]: EagerSlot<EagerPartContracts[P]>;
} & {
    readonly [P in PendingContractPart | ToolOwnedPart]: PartNote;
};

/** Static facts about a harness. Plain data, so reading identity never loads a part. */
export interface HarnessIdentity {
    /** "Claude Code", "Codex", "Grok". */
    readonly label: string;
    /** The executable a user starts. */
    readonly binary: string;
    /** The id of the provider plugin that carries this driver (`anthropic-sub`, `openai-sub`, `grok-sub`). */
    readonly plugin: string;
    /** Other spellings a user or another tool writes for the harness ("claude-code", "codex-cli"). */
    readonly aliases: readonly string[];
    /** How the apps draw the harness: the letter and colour of its badge (`ProviderBadge`, via `Harness.swift`). */
    readonly mark: HarnessMark;
}

/** A harness's badge: one letter on a square of one colour (sRGB, each channel 0 to 1). */
export interface HarnessMark {
    readonly letter: string;
    readonly color: { readonly red: number; readonly green: number; readonly blue: number };
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
    return { note: true, kind: "unsupported", reason };
}

export function pending(phase: HarnessPhase, reason: string): PartNote {
    return { note: true, kind: "pending", phase, reason };
}

export function toolOwned(owner: string, reason: string): PartNote {
    return { note: true, kind: "tool-owned", owner, reason };
}

export function isPartNote(slot: unknown): slot is PartNote {
    return typeof slot === "object" && slot !== null && "note" in slot && slot.note === true;
}
