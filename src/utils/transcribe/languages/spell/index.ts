import { hunspell, hunspellCc0 } from "./hunspell";
import { macos } from "./macos";
import type { SpellProvider } from "./types";

export type { SpellEngine, SpellProvider } from "./types";

/** Every spell checker the word check can use. A new one is a file in this folder plus a line here. */
export const SPELL_PROVIDERS = {
    hunspell,
    "hunspell-cc0": hunspellCc0,
    macos,
} satisfies Record<string, SpellProvider>;

export type SpellProviderId = keyof typeof SPELL_PROVIDERS;
export const SPELL_PROVIDER_IDS = Object.keys(SPELL_PROVIDERS) as SpellProviderId[];
export const DEFAULT_SPELL_PROVIDER: SpellProviderId = "hunspell";

export function isSpellProviderId(value: string): value is SpellProviderId {
    return value in SPELL_PROVIDERS;
}
