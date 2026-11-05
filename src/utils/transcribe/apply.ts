import { applyDictionary, type DictionaryNotes, type ResolvedDictionary } from "./dictionary";
import { heardIn, heardPattern, type LineAddress, type LineLookup, TranscriptLines } from "./lines";
import { formatClock } from "./render";
import type { TermFix } from "./terms";
import type { TranscriptEntry } from "./types";

/** Corrections a person confirmed, in the shape a transcript needs. Labels are the source's own labels. */
export interface TranscriptCorrections {
    /** Renames for the whole meeting: source label → name. */
    labels?: Record<string, string>;
    /** Lines of `label` from `fromSec` to `toSec` (inclusive) belong to `speaker`. */
    ranges?: Array<{ label: string; fromSec: number; toSec: number; speaker: string; item?: string }>;
    /**
     * The line starting at `atSec` (at index `line` of the source transcript, when known) lost its first word to the
     * line before; `speaker` says the voice of that line.
     */
    joins?: Array<{ atSec: number; line?: number; speaker?: string; joined?: string; item?: string }>;
    terms?: Array<TermFix & { line?: number; item?: string }>;
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
    /** The line's index in the source transcript, when known: it tells apart two lines that start in one second. */
    line?: number;
    heard: string;
    item?: string;
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

    // The transcript adds the backticks itself, so a meaning written with its own is not wrapped twice.
    const meaning = (mark.meaning ?? "").trim().replace(/^`+([\s\S]*?)`+$/, "$1");
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

/** What became of one decided item: applied to its lines, its words or line not found, two lines, or covered by another item. */
export type CorrectionOutcome = { item: string } & (
    | { status: "applied"; lines: LineAddress[] }
    | { status: "not-found"; reason: string }
    | { status: "ambiguous"; lines: LineAddress[]; reason: string }
    | { status: "shadowed"; by: string; reason: string }
);

export interface CorrectionsApplied {
    entries: TranscriptEntry[];
    /** One per correction that names its item, in the order the corrections were given. */
    outcomes: CorrectionOutcome[];
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

function bareWord(word: string): string {
    return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
}

/** The narrow lookup (lines that fit the item) when it names any line, else the wide one (any line at the time). */
function narrowed(narrow: LineLookup, wide: LineLookup): LineLookup {
    return narrow.kind === "none" ? wide : narrow;
}

/**
 * The line after a join's cut. The joined word ends with that line's first word, which tells apart two lines in
 * one second; with no line that fits, the one line at the time.
 */
export function joinLine(source: TranscriptLines, join: { atSec: number; line?: number; joined?: string }): LineLookup {
    const joined = join.joined?.toLowerCase();
    return narrowed(
        source.resolve(join, (entry, index) => {
            const word = bareWord(firstWord(entry.text).word);
            return index > 0 && joined !== undefined && word !== "" && joined.endsWith(word);
        }),
        source.resolve(join, (_entry, index) => index > 0)
    );
}

/** The line at an anchor that holds the heard words; with none that holds them, the one line at the time. */
export function heardLineAt(
    source: TranscriptLines,
    anchor: { atSec: number; line?: number },
    heard: string
): LineLookup {
    return narrowed(
        source.resolve(anchor, (entry) => heardIn(entry.text, heard).length > 0),
        source.resolve(anchor)
    );
}

/** A line before a cut starts at most this long before the line after it. */
const CUT_BEFORE_SEC = 5;

/**
 * The line a cut word starts in: the nearest earlier line whose last word begins the joined word (another voice may
 * sit between them when two lines start in one second), else the line just before.
 */
function lineBeforeCut(
    lines: TranscriptEntry[],
    index: number,
    joined: string | undefined
): TranscriptEntry | undefined {
    const earlier = lines.slice(0, index).filter((entry) => entry.text.trim());
    const startSec = lines[index]?.startSec;
    const word = joined?.toLowerCase();
    const starts = earlier.findLast((entry) => {
        const last = bareWord(entry.text.trim().split(/\s+/).at(-1) ?? "");
        const near =
            startSec === undefined || entry.startSec === undefined || startSec - entry.startSec <= CUT_BEFORE_SEC;
        return near && word !== undefined && last !== "" && word.startsWith(last);
    });

    return starts ?? earlier.at(-1);
}

/**
 * Applies the corrections in a fixed order, each on the source's own labels: joins first (they move a word between
 * two lines), then ranges, then open speaker questions, then renames, then quote and meaning marks, then term fixes,
 * then the dictionary, then open words. Each item's line is found by its address (index plus start) in the source
 * lines; two lines in one second that both fit are reported as ambiguous, never guessed.
 */
export function applyCorrections(entries: TranscriptEntry[], corrections: TranscriptCorrections): CorrectionsApplied {
    const source = new TranscriptLines(entries);
    const all = entries.map((entry) => ({ ...entry }));
    let lines = all;
    const indexOf = new Map(all.map((line, index) => [line, index]));
    const outcomes: CorrectionOutcome[] = [];
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
    const addressOf = (line: TranscriptEntry): LineAddress[] => {
        const address = source.address(indexOf.get(line) ?? -1);
        return address ? [address] : [];
    };
    const at = (sec: number) => formatClock(sec);
    const ambiguous = (item: string, found: { indexes: number[] }, what: string, sec: number): CorrectionOutcome => ({
        item,
        status: "ambiguous",
        lines: found.indexes.flatMap((index) => source.address(index) ?? []),
        reason: `${found.indexes.length} lines start at ${at(sec)}${what}`,
    });

    // Ranges name the source's labels: each line is matched by the label it came with, so a line a range moved to a
    // name that is also a label ("Alice Example") is not moved again by that label's ranges. A join that names the
    // voice settles its line.
    const sourceLabel = new Map(lines.map((line) => [line, line.speaker]));
    // The time a range reads for a line: a line a join glued a word onto keeps the time of the line the word came
    // from, so the range that covers the following line's voice covers the joined line too.
    const attributionTime = new Map(lines.map((line) => [line, line.startSec]));
    const voiced = new Map<TranscriptEntry, string | undefined>();
    const ranged = new Set<TranscriptEntry>();

    for (const join of corrections.joins ?? []) {
        const found = joinLine(source, join);

        if (found.kind !== "found") {
            if (join.item) {
                outcomes.push(
                    found.kind === "ambiguous"
                        ? ambiguous(join.item, found, ", and the join fits both", join.atSec)
                        : { item: join.item, status: "not-found", reason: `no line after a cut at ${at(join.atSec)}` }
                );
            }

            continue;
        }

        const line = all[found.index]!;
        const before = lineBeforeCut(all, found.index, join.joined);

        if (!before) {
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
            voiced.set(before, join.item);
        }

        line.text = rest;
        counts.joins += 1;

        if (join.item) {
            outcomes.push({ item: join.item, status: "applied", lines: [...addressOf(before), ...addressOf(line)] });
        }
    }

    lines = lines.filter((line) => line.text.trim());

    for (const range of corrections.ranges ?? []) {
        const labelled = lines.filter((line) => {
            const sec = attributionTime.get(line);
            return (
                sourceLabel.get(line) === range.label && sec !== undefined && sec >= range.fromSec && sec <= range.toSec
            );
        });
        const moved = labelled.filter((line) => !voiced.has(line));

        for (const line of moved) {
            line.speaker = range.speaker;
            ranged.add(line);
            counts.ranges += 1;
        }

        if (!range.item) {
            continue;
        }

        const by = labelled.map((line) => voiced.get(line)).find((item) => item !== undefined);
        outcomes.push(
            moved.length > 0
                ? { item: range.item, status: "applied", lines: moved.flatMap(addressOf) }
                : by
                  ? { item: range.item, status: "shadowed", by, reason: `${by} gave its lines a voice` }
                  : {
                        item: range.item,
                        status: "not-found",
                        reason: `no line of "${range.label}" from ${at(range.fromSec)} to ${at(range.toSec)}`,
                    }
        );
    }

    const unclearLabel = corrections.unclear?.label ?? "";

    // An open speaker question replaces the source label it is about, before renames could hide it. A line a range or
    // a join already gave a voice is decided, whatever it is called now, and a line is marked once: the first passage wins.
    const speakerMarked = new Set<TranscriptEntry>();

    for (const passage of corrections.unclear?.passages ?? []) {
        for (const line of lines) {
            const open =
                passage.speaker !== undefined &&
                sourceLabel.get(line) === passage.speaker &&
                !ranged.has(line) &&
                !voiced.has(line) &&
                !speakerMarked.has(line) &&
                inRange(line, passage);

            if (open) {
                speakerMarked.add(line);
                line.speaker = unclearMarker(unclearLabel, passage.speaker!, passage.readings);
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
    const markedBy: Array<string | undefined> = [];
    const markedLines = new Map<TranscriptEntry, number[]>();

    for (const mark of corrections.marks ?? []) {
        const found = heardLineAt(source, mark, mark.heard);
        const line = found.kind === "found" ? all[found.index] : undefined;
        const hit = line ? heardIn(line.text, mark.heard)[0] : undefined;

        if (!line || !hit) {
            if (mark.item) {
                const earlier = line
                    ? markedLines
                          .get(line)
                          ?.map((index) => markedBy[index])
                          .find(Boolean)
                    : undefined;
                outcomes.push(
                    found.kind === "ambiguous"
                        ? ambiguous(mark.item, found, ` with "${mark.heard}"`, mark.atSec)
                        : earlier
                          ? {
                                item: mark.item,
                                status: "shadowed",
                                by: earlier,
                                reason: `${earlier} marked those words`,
                            }
                          : { item: mark.item, status: "not-found", reason: `no "${mark.heard}" at ${at(mark.atSec)}` }
                );
            }

            continue;
        }

        const placeholder = `\uE000${marked.length}\uE000`;
        markedLines.set(line, [...(markedLines.get(line) ?? []), marked.length]);
        markedBy.push(mark.item);
        marked.push(writtenMark(mark, corrections.notes ?? "inline"));
        line.text = `${line.text.slice(0, hit.at)}${placeholder}${line.text.slice(hit.at + hit.text.length)}`;
        counts.marks += 1;

        if (mark.item) {
            outcomes.push({ item: mark.item, status: "applied", lines: addressOf(line) });
        }
    }

    // A term fix covers its words everywhere, or only in its own line. A fix that finds nothing left was covered by an
    // earlier mark or fix of the same words.
    const fixedBy: Array<{ item?: string; heard: string; lines: Set<TranscriptEntry> }> = [];

    for (const fix of corrections.terms ?? []) {
        let targets: TranscriptEntry[] = lines;

        if (fix.atSec !== undefined) {
            const found = heardLineAt(source, { atSec: fix.atSec, line: fix.line }, fix.heard);

            if (found.kind !== "found") {
                if (fix.item) {
                    outcomes.push(
                        found.kind === "ambiguous"
                            ? ambiguous(fix.item, found, ` with "${fix.heard}"`, fix.atSec)
                            : { item: fix.item, status: "not-found", reason: `no line at ${at(fix.atSec)}` }
                    );
                }

                continue;
            }

            targets = [all[found.index]!];
        }

        const re = heardPattern(fix.heard);
        const changed = new Set<TranscriptEntry>();

        for (const line of targets) {
            line.text = line.text.replace(re, () => {
                changed.add(line);
                counts.terms += 1;
                return fix.replacement;
            });
        }

        fixedBy.push({ item: fix.item, heard: fix.heard, lines: changed });

        if (!fix.item) {
            continue;
        }

        if (changed.size > 0) {
            outcomes.push({ item: fix.item, status: "applied", lines: [...changed].flatMap(addressOf) });
            continue;
        }

        const where = fix.atSec !== undefined ? ` at ${at(fix.atSec)}` : "";
        const heardOnce = targets.some((line) => {
            const index = indexOf.get(line);
            return index !== undefined && heardIn(entries[index]!.text, fix.heard).length > 0;
        });
        const overlaps = (heard: string) =>
            heardIn(heard, fix.heard).length > 0 || heardIn(fix.heard, heard).length > 0;
        const by = heardOnce
            ? [
                  ...(corrections.marks ?? [])
                      .filter((mark) => mark.item && overlaps(mark.heard))
                      .map((mark) => mark.item),
                  ...fixedBy
                      .filter((earlier) => earlier.item && earlier.lines.size > 0 && overlaps(earlier.heard))
                      .map((earlier) => earlier.item),
              ].find((item) => item && item !== fix.item)
            : undefined;
        outcomes.push(
            by
                ? { item: fix.item, status: "shadowed", by, reason: `${by} changed "${fix.heard}" first` }
                : { item: fix.item, status: "not-found", reason: `no "${fix.heard}"${where}` }
        );
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

        const word = heardPattern(heard, "iu");

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

    return { entries: lines, outcomes, ...counts };
}
