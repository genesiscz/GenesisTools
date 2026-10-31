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

/**
 * Every part, by name. A part lists only code a caller reads: a part a harness cannot have says so inside its own
 * contract (the `dialog` part is a `DialogKeyMap`, whose `supported: false` arm carries the reason), never as a note
 * in place of the code. The planned parts that had no code yet (questions, live, statusline, compaction, and the
 * tool-owned cmux, answer, spend, mcp and subagents tables) were dropped on 2026-10-31; each tool keeps its own
 * exhaustive table keyed by `HarnessId`.
 */
export const HARNESS_PART_LOADING = {
    locate: "eager",
    parse: "lazy",
    turnState: "eager",
    launch: "eager",
    exit: "eager",
    hooks: "eager",
    process: "eager",
    host: "eager",
    worker: "eager",
    transcript: "eager",
    dialog: "eager",
} as const satisfies {
    readonly [P in keyof HarnessPartContracts]: P extends keyof LazyPartContracts ? "lazy" : "eager";
};

export type HarnessPartName = keyof HarnessPartContracts;

/** Every part, in the order of the inventory sections (plan section 1). */
export const HARNESS_PARTS = Object.keys(HARNESS_PART_LOADING) as HarnessPartName[];

/**
 * Every part is a required key, so the compiler names each driver that lacks one. A lazy part is a loader, so reading
 * the driver never loads its parser; an eager part is the value itself.
 */
export type HarnessParts = { readonly [P in keyof LazyPartContracts]: Lazy<LazyPartContracts[P]> } & {
    readonly [P in keyof EagerPartContracts]: EagerPartContracts[P];
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
    /**
     * The model-provider plugin id of the company behind the harness (`anthropic`, `openai`, `xai`): an account row of
     * that provider wears the harness's mark (`AIProviderMark`, via `Harness.swift`).
     */
    readonly vendor: string;
    /** How the apps draw the harness: its badge, its tag colour and its logo (via `Harness.swift`). */
    readonly mark: HarnessMark;
}

/** An sRGB colour, each channel 0 to 1. */
export interface HarnessColor {
    readonly red: number;
    readonly green: number;
    readonly blue: number;
}

/** How the apps draw a harness: its letter, its one colour and its logo. */
export interface HarnessMark {
    /** The letter of its badge (`ProviderBadge`) when no logo is drawn. */
    readonly letter: string;
    /**
     * The harness's one colour in the apps (`Harness.color`): the badge square (`ProviderBadge`), the roster tag
     * (`AgentRosterStyle.harnessColor`) and the provider rows (`AIProviders.known`).
     */
    readonly color: HarnessColor;
    /**
     * The logo as one SVG path in a 24 x 24 box, filled even-odd (`AIProviderMark`), or null to keep the letter. The
     * paths come from LobeHub's icon set (MIT, `@lobehub/icons-static-svg`).
     */
    readonly logo: string | null;
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
