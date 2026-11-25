import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { foldText } from "@genesiscz/utils/macos/ocr-boxes";
import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import { type RawTermEvidence, SoundMatcher, type UnknownWord } from "@genesiscz/utils/transcribe/terms";
import { CallTimeline } from "./call-timeline";
import { hasFrameIndex, ocrPath } from "./frame-index";
import { readScreenRecord, type ScreenRecordRead, screenFramesAt } from "./screen-boxes";
import type { DocumentEvidence } from "./suggest-terms";

/**
 * The screen next to the term leads of `evidence --raw` (I7): what the screen showed near an unclear word wins over a
 * guess (polishing D7), so each unknown word, vocabulary run and spoken identifier carries the OCR lines of the frames
 * near it whose words sound like it.
 */

/** Seconds before and after a lead's time whose frames it gets; a frame is kept only when the screen changes. */
export const SCREEN_LEAD_WINDOW_SEC = 60;
/** Screen lines per lead unless `--screen-lines` says otherwise. */
export const DEFAULT_SCREEN_LINES = 3;
/** A screen form must sound at least this close to the lead (0 to 100) to be listed. */
const MIN_SCORE = 60;
/**
 * A screen form must sound this close to a term fix's words before `items add` warns that the screen spells it
 * otherwise. Measured on three recorded meetings (2026-11-25): at 75 most warnings named another word that only sounds
 * alike ("privacy" near a name, "Charts" near "courtesy").
 */
const CONFLICT_MIN_SCORE = 85;
/** A Czech case ending, or a slang ending on a loan word: `správy` and `správě`, `YAMLu` and `yaml`. */
const ENDING_CHARS = 3;
/** The letters Czech endings are made of, folded (`-ovi`, `-ách`, `-em`, `-ým`): `ContentRoes` is no ending of `ContentRows`. */
const ENDING_LETTERS = /^[aeiouymvhc]*$/;
/** The shortest shared start that makes two forms one word with different endings. */
const STEM_CHARS = 4;
/** An OCR line is cut to this many characters: a code line or a paragraph can run long. */
const MAX_LINE_CHARS = 200;

/** One OCR line of a frame near a lead whose words sound like it. */
export interface ScreenLine {
    /** The frame's transcript second. */
    atSec: number;
    /** The frame file, relative to the meeting folder. */
    frame: string;
    displayId?: number;
    /** The words of the line that match, as the screen shows them. */
    form: string;
    /** The whole OCR line. */
    text: string;
    /** 0 to 100: how close `form` sounds to the lead, by the score of the vocabulary match. */
    score: number;
    /** The written form that matched, when it is not the heard words: a candidate term or the identifier. */
    via?: string;
}

/** The screen next to one lead: how many frames with text were near it, and their lines that match, best first. */
export interface ScreenNear {
    frames: number;
    lines: ScreenLine[];
}

type WithScreen<T> = T & { screen?: ScreenNear };

/** The term part of `evidence --raw`; each lead has `screen` when the meeting kept a screen record. */
export interface RawTerms extends Omit<RawTermEvidence, "runs" | "unknown"> {
    runs: Array<WithScreen<RawTermEvidence["runs"][number]>>;
    unknown: Array<WithScreen<UnknownWord>>;
    documents?: Omit<DocumentEvidence, "identifiers"> & {
        identifiers: Array<WithScreen<DocumentEvidence["identifiers"][number]>>;
    };
}

/** The screen record `evidence` names: where its text is, how many frames and when, or that the meeting kept none. */
export type ScreenRecordFacts =
    | { recorded: false; note: string }
    | {
          recorded: true;
          /** The OCR file the screen lines come from. */
          ocr: string;
          frames: number;
          /** Kept frames the OCR worker has not read yet: they have no text so far. */
          pending: number;
          /** The first and the last frame, in transcript seconds. */
          fromSec: number;
          toSec: number;
          /** How the term leads got their screen lines (`evidence --raw` only); `linesPerLead` 0 turns them off. */
          leads?: { windowSec: number; linesPerLead: number };
          /** The command that shows the frames at a time. */
          read: string;
      };

/** The meeting's screen record on the transcript clock that `screen --at` uses; undefined when it kept none. */
export async function openScreenRecord(
    store: MeetingStore,
    record: MeetingRecord
): Promise<ScreenRecordRead | undefined> {
    if (!hasFrameIndex(store.folder(record.id))) {
        return undefined;
    }

    return readScreenRecord({ store, record, zeroMs: (await CallTimeline.forRecord(record)).zeroMs });
}

export function screenRecordFacts(options: {
    id: string;
    read: ScreenRecordRead | undefined;
    linesPerLead?: number;
}): ScreenRecordFacts {
    const { read } = options;

    if (!read || read.rows.length === 0) {
        return {
            recorded: false,
            note: "This meeting has no screen recording: no frame and no screen text to check a term against.",
        };
    }

    const secOf = (at: string) => Math.round((Date.parse(at) - read.zeroMs) / 100) / 10;
    return {
        recorded: true,
        ocr: ocrPath(read.folder),
        frames: read.rows.length,
        pending: read.pending,
        fromSec: secOf(read.rows[0]!.at),
        toSec: secOf(read.rows.at(-1)!.at),
        ...(options.linesPerLead === undefined
            ? {}
            : { leads: { windowSec: SCREEN_LEAD_WINDOW_SEC, linesPerLead: options.linesPerLead } }),
        read: toolCommand("meetings", "screen", options.id, "--at", "<time>"),
    };
}

/** The screen record in one line, for the evidence table and the compact lines. */
export function screenRecordLine(facts: ScreenRecordFacts): string {
    if (!facts.recorded) {
        return `screen: ${facts.note}`;
    }

    const pending = facts.pending > 0 ? `, ${facts.pending} without OCR yet` : "";
    const frames = `${facts.frames} ${facts.frames === 1 ? "frame" : "frames"}`;
    return `screen: ${frames} with OCR in ${facts.ocr}${pending}, ${formatClock(facts.fromSec)} to ${formatClock(facts.toSec)}; what it showed at a time: ${facts.read}`;
}

interface LineWords {
    text: string;
    folded: string;
    words: string[];
}

const SCREEN_WORD = /[\p{L}\p{N}][\p{L}\p{N}._/'-]*/gu;

/** The OCR lines of a frame, split into words once per frame file for every lead that reads it. */
function lineCache(): (file: string, text: string) => LineWords[] {
    const split = new Map<string, LineWords[]>();
    return (file, text) => {
        let lines = split.get(file);

        if (!lines) {
            lines = text
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line) => ({
                    text: line,
                    folded: foldText(line),
                    words: (line.match(SCREEN_WORD) ?? []).map((word) => word.replace(/[._/'-]+$/, "")),
                }));
            split.set(file, lines);
        }

        return lines;
    };
}

/** Each lead of the term part with the screen lines near it: the read is shared, the words of a line are split once. */
export function withScreenLines(terms: RawTerms, options: { read: ScreenRecordRead; linesPerLead: number }): RawTerms {
    const matcher = new SoundMatcher();
    const linesOf = lineCache();
    const near = (lead: { heard: string; written: string[]; times: number[] }): ScreenNear =>
        screenNear({ ...lead, read: options.read, matcher, linesOf, linesPerLead: options.linesPerLead });
    const timesOf = (examples: Array<{ atSec?: number }>) =>
        examples.flatMap((example) => (example.atSec === undefined ? [] : [example.atSec]));

    return {
        ...terms,
        runs: terms.runs.map((run) => ({
            ...run,
            screen: near({
                heard: run.heard,
                written: run.candidates.map((candidate) => candidate.term),
                times: timesOf(run.examples),
            }),
        })),
        unknown: terms.unknown.map((word) => ({
            ...word,
            screen: near({
                heard: word.heard,
                written: word.candidates.map((candidate) => candidate.term),
                times: timesOf(word.examples),
            }),
        })),
        ...(terms.documents
            ? {
                  documents: {
                      ...terms.documents,
                      identifiers: terms.documents.identifiers.map((match) => ({
                          ...match,
                          screen: near({
                              heard: match.heard,
                              written: [match.identifier],
                              times: match.atSec === undefined ? [] : [match.atSec],
                          }),
                      })),
                  },
              }
            : {}),
    };
}

/** A term fix as `items add` checks it against the screen. */
export interface TermFix {
    atSec: number;
    heard: string;
    proposed: string;
}

/**
 * The screen line near a term fix that spells it otherwise: of the frames within 60 s of the fix, a line whose words
 * sound like the heard words or the fix (at least 85 of 100), when no line near it shows the fix itself. Undefined
 * when the screen agrees, shows nothing like it, or kept no frame then.
 */
export function termScreenConflict(options: {
    read: ScreenRecordRead;
    fix: TermFix;
    matcher?: SoundMatcher;
    linesOf?: (file: string, text: string) => LineWords[];
}): ScreenLine | undefined {
    const { fix } = options;
    const near = screenNear({
        heard: fix.heard,
        written: [fix.proposed],
        times: [fix.atSec],
        read: options.read,
        matcher: options.matcher ?? new SoundMatcher(),
        linesOf: options.linesOf ?? lineCache(),
        linesPerLead: DEFAULT_SCREEN_LINES,
    });
    if (near.lines.some((line) => sameSpelling(line.form, fix.proposed))) {
        return undefined;
    }

    return near.lines.find((line) => line.score >= CONFLICT_MIN_SCORE);
}

/** Letters and digits only, folded: `col-administration`, `COL_ADMINISTRATION` and `col administration` are one form. */
function spellingKey(text: string): string {
    return foldText(text).replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Whether the screen form spells the fix the same way, give or take what a screen shows of a spoken word: case,
 * accents and separators, a longer or shorter word around it (`Jenkins` on screen, `Jenkinsfile` said), or another
 * ending of the same stem (`klienti` on screen, `klientovi` said).
 */
function sameSpelling(screen: string, proposed: string): boolean {
    const a = spellingKey(screen);
    const b = spellingKey(proposed);

    if (a === b || a.startsWith(b) || b.startsWith(a)) {
        return true;
    }

    let shared = 0;

    while (shared < a.length && a[shared] === b[shared]) {
        shared += 1;
    }

    const endings = [a.slice(shared), b.slice(shared)];
    return (
        shared >= STEM_CHARS && endings.every((ending) => ending.length <= ENDING_CHARS && ENDING_LETTERS.test(ending))
    );
}

/** The key `termScreenWarnings` files a fix under. */
export function termFixKey(fix: TermFix): string {
    return SafeJSON.stringify([fix.atSec, fix.heard, fix.proposed]);
}

/**
 * `items add`: for each term fix whose nearby screen spells it otherwise, the warning to print, keyed by
 * {@link termFixKey}. Reads the screen record only when there is a fix to check; a meeting without one gets none.
 */
export async function termScreenWarnings(options: {
    store: MeetingStore;
    record: MeetingRecord;
    fixes: TermFix[];
}): Promise<Map<string, string>> {
    const warnings = new Map<string, string>();
    const read = options.fixes.length > 0 ? await openScreenRecord(options.store, options.record) : undefined;

    if (!read) {
        return warnings;
    }

    const matcher = new SoundMatcher();
    const linesOf = lineCache();

    for (const fix of options.fixes) {
        const line = termScreenConflict({ read, fix, matcher, linesOf });

        if (line) {
            warnings.set(
                termFixKey(fix),
                `the screen at ${formatClock(line.atSec)} shows "${line.form}" (${line.score} % like it, ${line.frame}), not "${fix.proposed}": look at ${toolCommand("meetings", "screen", options.record.id, "--at", formatClock(line.atSec))} before it is confirmed`
            );
        }
    }

    return warnings;
}

/** The lines of the frames within the window of any of the lead's times that sound like it, best first, one per text. */
function screenNear(options: {
    heard: string;
    written: string[];
    times: number[];
    read: ScreenRecordRead;
    matcher: SoundMatcher;
    linesOf: (file: string, text: string) => LineWords[];
    linesPerLead: number;
}): ScreenNear {
    const { read } = options;
    const frames = new Map<string, { file: string; at: string; displayId?: number; text: string; distance: number }>();

    for (const atSec of options.times) {
        const { displays } = screenFramesAt(read, atSec, 2 * SCREEN_LEAD_WINDOW_SEC);

        for (const frame of displays.flatMap((display) => display.frames)) {
            if (frame.pending || !frame.text.trim()) {
                continue;
            }

            const distance = Math.abs((Date.parse(frame.at) - read.zeroMs) / 1000 - atSec);
            const seen = frames.get(frame.file);

            if (!seen || distance < seen.distance) {
                frames.set(frame.file, { ...frame, distance });
            }
        }
    }

    const queries = [
        { text: options.heard, via: undefined },
        ...[...new Set(options.written)]
            .filter((written) => foldText(written) !== foldText(options.heard))
            .map((written) => ({ text: written, via: written })),
    ].map((query) => ({ ...query, words: query.text.trim().split(/\s+/).length }));
    // A line repeats on every frame of a still screen: score its text once, and keep one line per screen form.
    const scored = new Map<string, ReturnType<typeof bestForm> | null>();
    const byForm = new Map<string, ScreenLine & { distance: number }>();

    for (const frame of frames.values()) {
        for (const line of options.linesOf(frame.file, frame.text)) {
            let match = scored.get(line.folded);

            if (match === undefined) {
                match = bestForm({ line, queries, matcher: options.matcher }) ?? null;
                scored.set(line.folded, match);
            }

            if (!match) {
                continue;
            }

            const form = foldText(match.form);
            const seen = byForm.get(form);

            if (seen && (seen.score > match.score || (seen.score === match.score && seen.distance <= frame.distance))) {
                continue;
            }

            byForm.set(form, {
                atSec: Math.round((Date.parse(frame.at) - read.zeroMs) / 100) / 10,
                frame: frame.file,
                ...(frame.displayId !== undefined ? { displayId: frame.displayId } : {}),
                form: match.form,
                text: [...line.text].slice(0, MAX_LINE_CHARS).join(""),
                score: match.score,
                ...(match.via ? { via: match.via } : {}),
                distance: frame.distance,
            });
        }
    }

    return {
        frames: frames.size,
        lines: [...byForm.values()]
            .sort((a, b) => b.score - a.score || a.distance - b.distance)
            .slice(0, options.linesPerLead)
            .map(({ distance: _distance, ...line }) => line),
    };
}

/** The run of a line's words that sounds most like one of the queries, at or above the floor. */
function bestForm(options: {
    line: LineWords;
    queries: Array<{ text: string; via?: string; words: number }>;
    matcher: SoundMatcher;
}): { form: string; score: number; via?: string } | undefined {
    const { words } = options.line;
    let found: { form: string; score: number; via?: string } | undefined;

    for (const query of options.queries) {
        for (let size = 1; size <= query.words + 1; size++) {
            for (let start = 0; start + size <= words.length; start++) {
                const form = words.slice(start, start + size).join(" ");
                const score = options.matcher.score(query.text, form);

                if (score !== undefined && score >= MIN_SCORE && (!found || score > found.score)) {
                    found = { form, score, ...(query.via ? { via: query.via } : {}) };
                }
            }
        }
    }

    return found;
}
