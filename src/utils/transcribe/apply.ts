import { applyDictionary, type ResolvedDictionary } from "./dictionary";
import { applyFixes, type TermFix } from "./terms";
import type { TranscriptEntry } from "./types";

/** A join is found at the line that starts this close to the recorded time. */
const JOIN_MATCH_SEC = 0.5;

/** Corrections a person confirmed, in the shape a transcript needs. Labels are the source's own labels. */
export interface TranscriptCorrections {
    /** Renames for the whole meeting: source label → name. */
    labels?: Record<string, string>;
    /** Lines of `label` from `fromSec` to `toSec` (inclusive) belong to `speaker`. */
    ranges?: Array<{ label: string; fromSec: number; toSec: number; speaker: string }>;
    /** The line starting at `atSec` lost its first word to the line before; `speaker` says the voice of that line. */
    joins?: Array<{ atSec: number; speaker?: string }>;
    terms?: TermFix[];
    dictionary?: ResolvedDictionary;
}

export interface CorrectionsApplied {
    entries: TranscriptEntry[];
    labels: number;
    ranges: number;
    joins: number;
    terms: number;
    fixes: number;
    expansions: number;
}

function firstWord(text: string): { word: string; rest: string } {
    const match = /^(\S+)\s*([\s\S]*)$/.exec(text.trim());
    return match ? { word: match[1]!, rest: match[2]! } : { word: "", rest: "" };
}

/**
 * Applies the corrections in a fixed order, each on the source's own labels: joins first (they move a word between
 * two lines), then ranges, then renames, then term fixes, then the dictionary.
 */
export function applyCorrections(entries: TranscriptEntry[], corrections: TranscriptCorrections): CorrectionsApplied {
    let lines = entries.map((entry) => ({ ...entry }));
    const counts = { labels: 0, ranges: 0, joins: 0, terms: 0, fixes: 0, expansions: 0 };

    for (const join of corrections.joins ?? []) {
        const index = lines.findIndex(
            (line) => line.startSec !== undefined && Math.abs(line.startSec - join.atSec) <= JOIN_MATCH_SEC
        );
        const before = lines[index - 1];
        const line = lines[index];

        if (index < 1 || !before || !line) {
            continue;
        }

        const { word, rest } = firstWord(line.text);
        before.text = `${before.text.trimEnd()}${word}`;
        before.speaker = join.speaker ?? line.speaker;
        line.text = rest;
        counts.joins += 1;
    }

    lines = lines.filter((line) => line.text.trim());

    for (const range of corrections.ranges ?? []) {
        for (const line of lines) {
            const inside =
                line.speaker === range.label &&
                line.startSec !== undefined &&
                line.startSec >= range.fromSec &&
                line.startSec <= range.toSec;

            if (inside) {
                line.speaker = range.speaker;
                counts.ranges += 1;
            }
        }
    }

    for (const line of lines) {
        const renamed = corrections.labels?.[line.speaker];

        if (renamed) {
            line.speaker = renamed;
            counts.labels += 1;
        }
    }

    if (corrections.terms && corrections.terms.length > 0) {
        const fixed = applyFixes(lines, corrections.terms);
        lines = fixed.entries;
        counts.terms = fixed.replaced;
    }

    if (corrections.dictionary) {
        const applied = applyDictionary(lines, corrections.dictionary);
        lines = applied.entries;
        counts.fixes = applied.fixes;
        counts.expansions = applied.expansions;
    }

    return { entries: lines, ...counts };
}
