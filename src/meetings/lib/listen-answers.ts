import type { MeetingItem, MeetingRecord } from "@genesiscz/utils/meetings/record";
import { heardLineAt } from "@genesiscz/utils/transcribe/apply";
import type { TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import { termFixPattern } from "@genesiscz/utils/transcribe/terms";
import { storedPresentAt } from "./person-stays";

export interface DecidedLine {
    index: number;
    startSec?: number;
    endSec?: number;
    speaker: string;
    text: string;
}

/** The source lines an item changes. Ranges keep the correction engine's inclusive end and label filter. */
export function itemLines(item: MeetingItem, transcript: TranscriptLines): DecidedLine[] {
    const matches = lineMatcher(item, transcript);

    return transcript.entries.flatMap((entry, index) =>
        matches(entry, index) && entry.text.trim()
            ? [
                  {
                      index,
                      startSec: entry.startSec,
                      endSec: transcript.end(index),
                      speaker: entry.speaker,
                      text: entry.text,
                  },
              ]
            : []
    );
}

/**
 * Whether a source line belongs to `item`. A term's pattern and anchors depend on the item only, so they are resolved
 * once here and not again for every line; every anchor must still resolve, and the line must be one of them.
 */
function lineMatcher(
    item: MeetingItem,
    transcript: TranscriptLines
): (entry: TranscriptLines["entries"][number], index: number) => boolean {
    if (item.kind === "speaker-range" || item.kind === "label") {
        return (entry) =>
            entry.startSec !== undefined &&
            entry.startSec >= item.fromSec &&
            entry.startSec <= item.toSec &&
            entry.speaker === item.label;
    }

    if (item.kind === "term") {
        const found = termFixPattern({ ...item, replacement: item.proposed ?? item.heard });
        // One test per line: a global pattern would carry its position from one line to the next.
        const pattern = new RegExp(found.source, found.flags.replace("g", ""));
        const local = item.scope === "line" || item.quote !== undefined || item.meaning !== undefined;
        const anchorLine = item.evidence?.transcriptLine;
        const anchors =
            item.reach?.lines ??
            (local && item.atSec !== undefined
                ? [{ atSec: item.atSec, ...(typeof anchorLine === "number" ? { line: anchorLine } : {}) }]
                : undefined);
        const targets = anchors?.map((anchor) => heardLineAt(transcript, anchor, found));
        const lines =
            targets === undefined
                ? undefined
                : targets.every((target) => target.kind === "found")
                  ? new Set(targets.flatMap((target) => (target.kind === "found" ? [target.index] : [])))
                  : new Set<number>();
        return (entry, index) => (lines === undefined || lines.has(index)) && pattern.test(entry.text);
    }

    if (item.kind === "join") {
        return (entry) => entry.startSec === item.atSec;
    }

    return (entry) =>
        entry.startSec !== undefined &&
        entry.startSec >= item.fromSec &&
        (entry.startSec < item.toSec || entry.startSec === item.fromSec);
}

/** A question decides its targets wherever they are, or its own half-open span when it has no targets. */
export function decidedLines(options: {
    record: MeetingRecord;
    question: Extract<MeetingItem, { kind: "question" }>;
    transcript: TranscriptLines;
}): DecidedLine[] {
    const { record, question, transcript } = options;
    const targets = record.items.filter((item) => question.decides.includes(item.id));
    const lines = (targets.length ? targets : [question]).flatMap((item) => itemLines(item, transcript));
    return [...new Map(lines.map((line) => [line.index, line])).values()].sort((a, b) => a.index - b.index);
}

export function personKey(text: string): string {
    return nameTokens(text).sort().join(" ");
}

/** A text's words without accents, in lower case: the one folding that every name comparison here uses. */
function foldWords(text: string): string[] {
    return (
        text
            .normalize("NFD")
            .replace(/\p{M}/gu, "")
            .toLowerCase()
            .match(/[\p{L}\p{N}]+/gu) ?? []
    );
}

export type PersonAnswer = { kind: "people"; people: string[] } | { kind: "comment"; text: string };

export function parsePersonAnswer(options: { text: string; people: string[]; self?: string }): PersonAnswer {
    const text = options.text.trim();
    const seen = new Set<string>();
    const known = options.people.filter((name) => {
        const key = personKey(name);
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
    const exact = known.find((name) => personKey(name) === personKey(text));
    if (exact) {
        return { kind: "people", people: [exact] };
    }
    const folded = ` ${foldWords(text).join(" ")} `;
    const matches = known.flatMap((name) => {
        const tokens = nameTokens(name);
        const positions = tokens.filter((token) => token.length > 2).map((token) => folded.indexOf(` ${token} `));
        return positions.length > 0 && positions.every((at) => at >= 0)
            ? [{ name, at: Math.min(...positions), tokens }]
            : [];
    });
    if (options.self && /\b(me|myself|ja)\b/.test(folded)) {
        matches.push({
            name: options.self,
            at: Math.max(0, folded.search(/\b(me|myself|ja)\b/)),
            tokens: [...SELF_WORDS],
        });
    }
    const people = [...new Set(matches.sort((a, b) => a.at - b.at).map((match) => match.name))];
    if (people.length === 1 && /\b(then|potom|pak|second|druha|druhy|druhe)\b/.test(folded)) {
        return { kind: "comment", text };
    }
    // Only names joined into a list identify: any other word ("not", "whether", "cannot tell") keeps the prose a
    // comment, so a mention of a name never confirms a speaker.
    const named = new Set(matches.flatMap((match) => match.tokens));
    const rest = folded
        .trim()
        .split(" ")
        .filter((word) => word && !named.has(word) && !ANSWER_GLUE.has(word));
    return people.length > 0 && rest.length === 0 ? { kind: "people", people } : { kind: "comment", text };
}

/** The user's own words for themselves, which name `self` in a person answer. */
const SELF_WORDS = new Set(["me", "myself", "ja"]);

/** The words a person answer may hold besides the names: list joins, order words and an affirming lead-in. */
const ANSWER_GLUE_WORDS =
    "and a i plus with s se then potom pak first second nejdriv druha druhy druhe it is was that this to je byl byla";
const ANSWER_GLUE = new Set(ANSWER_GLUE_WORDS.split(" "));

/** A name's words, folded for matching, without a parenthesised note. */
function nameTokens(name: string): string[] {
    return foldWords(name.replace(/\([^)]*\)/g, ""));
}

export function recordPeople(record: MeetingRecord): string[] {
    return [
        ...new Set([
            ...record.participants.map((person) => person.name),
            ...(record.attendance?.people.map((person) => person.name) ?? []),
            ...Object.values(record.speakers.labels),
            ...record.items.flatMap((item) =>
                item.kind === "speaker-range" && item.status === "confirmed" && item.speaker ? [item.speaker] : []
            ),
        ]),
    ];
}

export interface VoiceSegment {
    fromWord: number;
    speaker: string;
}

export function sentenceSegments(text: string, people: string[]): VoiceSegment[] | undefined {
    const words = text.trim().split(/\s+/);
    const starts = [
        0,
        ...words.flatMap((word, index) => (/[.!?]["'”’)]*$/.test(word) && index + 1 < words.length ? [index + 1] : [])),
    ];
    if (starts.length < people.length) {
        return undefined;
    }
    return people.map((speaker, index) => ({ fromWord: starts[index]!, speaker }));
}

/**
 * Whether a person was in the call at a time, by the same stays every other reader starts from (`storedPresentAt`):
 * hand-corrected stays win over imported attendance, so the choices and the parsed answers agree with the presence.
 */
export function personPresent(record: MeetingRecord, name: string, sec: number): boolean {
    return storedPresentAt(record, name, sec);
}
