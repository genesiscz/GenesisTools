import { DEFAULT_SPELL_PROVIDER, SPELL_PROVIDER_IDS } from "@genesiscz/utils/transcribe/languages/spell";
import { openWordCheck, type WordCheck } from "@genesiscz/utils/transcribe/languages/word-check";
import { transcriptWords } from "@genesiscz/utils/transcribe/terms";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";

/** The word checks `--word-check` offers: each spell provider, or none. */
export const WORD_CHECKS = [...SPELL_PROVIDER_IDS, "off"] as const;
export type WordCheckChoice = (typeof WORD_CHECKS)[number];
export const DEFAULT_WORD_CHECK: WordCheckChoice = DEFAULT_SPELL_PROVIDER;

/** The word check over a transcript's words, or why there is none. The caller disposes the check. */
export async function wordCheckFor(
    choice: WordCheckChoice,
    transcript: TranscriptEntry[]
): Promise<{ check?: WordCheck; reason?: string }> {
    if (choice === "off") {
        return { reason: "turned off with --word-check off" };
    }

    const opened = await openWordCheck({ provider: choice, words: transcriptWords(transcript) });
    return opened.available ? { check: opened.check } : { reason: opened.reason };
}
