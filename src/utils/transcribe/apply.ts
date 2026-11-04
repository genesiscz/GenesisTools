import { applyDictionary, type DictionaryNotes, type ResolvedDictionary } from "./dictionary";
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
    joins?: Array<{ atSec: number; speaker?: string; joined?: string }>;
    terms?: TermFix[];
    /** Marks on one passage of one line: a meaning after it, or the document text it reads aloud. */
    marks?: TranscriptMark[];
    dictionary?: ResolvedDictionary;
    /** How the dictionary writes expansions and meanings: `sup` for Markdown, `inline` (the default) elsewhere. */
    notes?: DictionaryNotes;
    /** Passages nobody decided yet: each is written as `[<label>: "<raw>"; 1) … 2) …]` instead of a guess. */
    unclear?: { label: string; passages: UnclearPassage[] };
}

/**
 * An open question in the transcript. With `speaker` it is the voice of that label's lines in the range; with `heard`
 * it is those words in the range's lines. `readings` are the answers on offer.
 */
export interface UnclearPassage {
    fromSec: number;
    toSec: number;
    speaker?: string;
    heard?: string;
    readings: string[];
}

/** A mark on the passage `heard` of the line that starts at `atSec`. */
export interface TranscriptMark {
    atSec: number;
    heard: string;
    /** Shown after the words: `lomeno type <sup>(`/{type}`)</sup>`. */
    meaning?: string;
    /** The passage reads this document text aloud: the text replaces the words, with its source. */
    quote?: { text: string; source: string };
}

/** How a mark is written: a Markdown quote block and a superscript, or parentheses and quotation marks in plain text. */
function writtenMark(mark: TranscriptMark, notes: DictionaryNotes): string {
    if (mark.quote) {
        return notes === "sup"
            ? `\n\n> ${mark.quote.text} <sup>(${mark.quote.source})</sup>\n\n`
            : `„${mark.quote.text}“ (${mark.quote.source})`;
    }

    const meaning = mark.meaning ?? "";
    return notes === "sup" ? `${mark.heard} <sup>(\`${meaning}\`)</sup>` : `${mark.heard} (${meaning})`;
}

/** `[nejasné: "Speaker 5"; 1) Alice 2) Carol]`: the raw text, then each reading, so the reader sees what is open. */
export function unclearMarker(label: string, raw: string, readings: string[]): string {
    const listed = readings.map((reading, index) => `${index + 1}) ${reading}`).join(" ");
    return `[${label}: "${raw}"${listed ? `; ${listed}` : ""}]`;
}

function inRange(line: TranscriptEntry, passage: { fromSec: number; toSec: number }): boolean {
    return line.startSec !== undefined && line.startSec >= passage.fromSec && line.startSec <= passage.toSec;
}

export interface CorrectionsApplied {
    entries: TranscriptEntry[];
    labels: number;
    ranges: number;
    joins: number;
    terms: number;
    fixes: number;
    spoken: number;
    fuzzy: number;
    expansions: number;
    meanings: number;
    marks: number;
    unclear: number;
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
    const counts = {
        labels: 0,
        ranges: 0,
        joins: 0,
        terms: 0,
        fixes: 0,
        spoken: 0,
        fuzzy: 0,
        expansions: 0,
        meanings: 0,
        marks: 0,
        unclear: 0,
    };

    // Ranges name the source's labels: each line is matched by the label it came with, so a line a range moved to a
    // name that is also a label ("Alice Example") is not moved again by that label's ranges. A join that names the
    // voice settles its line.
    const sourceLabel = new Map(lines.map((line) => [line, line.speaker]));
    const attributionTime = new Map(lines.map((line) => [line, line.startSec]));
    const voiced = new Set<TranscriptEntry>();

    for (const join of corrections.joins ?? []) {
        const index = lines.findIndex(
            (line) => line.startSec !== undefined && Math.abs(line.startSec - join.atSec) <= JOIN_MATCH_SEC
        );
        const before = lines[index - 1];
        const line = lines[index];

        if (index < 1 || !before || !line) {
            continue;
        }

        // A cut word ("dot" | "áhnu") is glued back; a sentence cut between two whole words keeps its space.
        const { word, rest } = firstWord(line.text);
        const between = join.joined && /\s/.test(join.joined) ? " " : "";
        before.text = `${before.text.trimEnd()}${between}${word}`;
        before.speaker = join.speaker ?? line.speaker;
        sourceLabel.set(before, sourceLabel.get(line) ?? line.speaker);
        attributionTime.set(before, attributionTime.get(line));

        if (join.speaker) {
            voiced.add(before);
        }

        line.text = rest;
        counts.joins += 1;
    }

    lines = lines.filter((line) => line.text.trim());

    for (const range of corrections.ranges ?? []) {
        for (const line of lines) {
            const inside =
                !voiced.has(line) &&
                sourceLabel.get(line) === range.label &&
                attributionTime.get(line) !== undefined &&
                attributionTime.get(line)! >= range.fromSec &&
                attributionTime.get(line)! <= range.toSec;

            if (inside) {
                line.speaker = range.speaker;
                counts.ranges += 1;
            }
        }
    }

    const unclearLabel = corrections.unclear?.label ?? "";

    // An open speaker question replaces the source label it is about, before renames could hide it.
    for (const passage of corrections.unclear?.passages ?? []) {
        for (const line of lines) {
            if (passage.speaker && line.speaker === passage.speaker && inRange(line, passage)) {
                line.speaker = unclearMarker(unclearLabel, passage.speaker, passage.readings);
                counts.unclear += 1;
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

    // Marks go in as placeholders before the fixes and the dictionary, so the document text a quote carries stays as
    // written; the placeholders are filled in at the end.
    const marked: string[] = [];

    for (const mark of corrections.marks ?? []) {
        const line = lines.find(
            (entry) =>
                entry.startSec !== undefined &&
                Math.abs(entry.startSec - mark.atSec) <= JOIN_MATCH_SEC &&
                entry.text.includes(mark.heard)
        );
        const at = line?.text.indexOf(mark.heard) ?? -1;

        if (!line || at < 0) {
            continue;
        }

        const placeholder = `\uE000${marked.length}\uE000`;
        marked.push(writtenMark(mark, corrections.notes ?? "inline"));
        line.text = `${line.text.slice(0, at)}${placeholder}${line.text.slice(at + mark.heard.length)}`;
        counts.marks += 1;
    }

    if (corrections.terms && corrections.terms.length > 0) {
        const fixed = applyFixes(lines, corrections.terms);
        lines = fixed.entries;
        counts.terms = fixed.replaced;
    }

    if (corrections.dictionary) {
        const applied = applyDictionary(lines, corrections.dictionary, { notes: corrections.notes });
        lines = applied.entries;
        counts.fixes = applied.fixes;
        counts.spoken = applied.spoken;
        counts.fuzzy = applied.fuzzy;
        counts.expansions = applied.expansions;
        counts.meanings = applied.meanings;
    }

    // Open words last, so they are found as the reader sees the corrected line. Each marker goes in as a placeholder
    // too, so a later passage for the same words cannot mark the words inside it a second time.
    const unclearMarked: string[] = [];

    for (const passage of corrections.unclear?.passages ?? []) {
        const heard = passage.heard;

        if (!heard) {
            continue;
        }

        // Whole words only: JavaScript's `\b` treats "í" or "ž" as a word edge, so the edges are spelled out.
        const escaped = heard.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const word = new RegExp(`(?<![\\p{L}\\p{N}\\uE000\\uE001])${escaped}(?![\\p{L}\\p{N}\\uE000\\uE001])`, "u");

        for (const line of lines) {
            if (inRange(line, passage) && word.test(line.text)) {
                const placeholder = `\uE001${unclearMarked.length}\uE001`;
                unclearMarked.push(unclearMarker(unclearLabel, heard, passage.readings));
                line.text = line.text.replace(word, placeholder);
                counts.unclear += 1;
            }
        }
    }

    if (marked.length > 0 || unclearMarked.length > 0) {
        for (const line of lines) {
            line.text = line.text
                .replace(/\uE001(\d+)\uE001/g, (_, index: string) => unclearMarked[Number(index)] ?? "")
                .replace(/\uE000(\d+)\uE000/g, (_, index: string) => marked[Number(index)] ?? "");
        }
    }

    return { entries: lines, ...counts };
}
