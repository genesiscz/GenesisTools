import { SafeJSON } from "@genesiscz/utils/json";
import { languageSettings, type MeetingsConfig, resolveDictionary } from "@genesiscz/utils/meetings/config";
import type { Correction } from "@genesiscz/utils/meetings/corrections";
import type { MeetingItem, MeetingRecord } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import {
    applyCorrections,
    type CorrectionOutcome,
    type CorrectionsApplied,
    heardLineAt,
    joinLine,
    type TranscriptCorrections,
    type UnclearPassage,
} from "@genesiscz/utils/transcribe/apply";
import { LINE_AT_TOLERANCE_SEC, TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import { formatClock, type TranscriptFormat } from "@genesiscz/utils/transcribe/render";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { openQuestions } from "./questions";

/**
 * The open questions as passages a transcript marks: a speaker question marks the label of the ranges it decides, a
 * question with `heard` marks those words. With `applied`, an item it applies is never marked, and a speaker range
 * under `below` that no question asks is marked with its own guess.
 */
function unclearPassages(
    record: MeetingRecord,
    opts: { below: number; applied?: (item: MeetingItem) => boolean }
): UnclearPassage[] {
    const applied = opts.applied ?? (() => false);
    const open = openQuestions(record);
    const asked = new Set(open.flatMap((question) => question.decides));
    const unaskedLow = (item: MeetingItem) =>
        item.status === "suggested" && !applied(item) && !asked.has(item.id) && (item.confidence ?? 1) < opts.below;
    // A low term the rules have a guess for is marked wherever it was heard, even unasked. An unknown word with no
    // guess is often plain spoken Czech no dictionary has ("byznysák"): it stays text unless it is asked.
    const unaskedTerms = record.items.flatMap((item): UnclearPassage[] =>
        item.kind === "term" &&
        item.proposed !== undefined &&
        !item.rules.includes(MeetingRule.UnknownWord) &&
        unaskedLow(item)
            ? [
                  {
                      fromSec: item.scope === "line" && item.atSec !== undefined ? item.atSec : 0,
                      toSec: item.scope === "line" && item.atSec !== undefined ? item.atSec : Number.POSITIVE_INFINITY,
                      heard: item.heard,
                      readings: withConfidence([item.proposed], item.confidence),
                  },
              ]
            : []
    );
    // A range with candidates and no speaker says only that the label is wrong; it is marked at any confidence, and
    // its confidence is that the label is wrong, so no candidate carries it. A line marks once, so a range that names
    // someone goes first.
    const ranges = record.items.filter(
        (item): item is Extract<MeetingItem, { kind: "speaker-range" }> => item.kind === "speaker-range"
    );
    const unaskedRanges = opts.applied
        ? [...ranges.filter((item) => item.speaker), ...ranges.filter((item) => !item.speaker)].flatMap(
              (item): UnclearPassage[] => {
                  const nobody = !item.speaker && item.status === "suggested" && !asked.has(item.id);

                  if (!nobody && !unaskedLow(item)) {
                      return [];
                  }

                  return [
                      {
                          fromSec: item.fromSec,
                          toSec: item.toSec,
                          speaker: item.label,
                          readings: item.speaker
                              ? withConfidence([item.speaker], item.confidence)
                              : (item.candidates ?? []),
                      },
                  ];
              }
          )
        : [];

    // Questions first: a word is marked once, and a question's choices say more than a low term's own guess.
    return [
        ...open.flatMap((question): UnclearPassage[] => {
            const decided = record.items.filter((item) => question.decides.includes(item.id));

            if (question.heard) {
                if (decided.some(applied)) {
                    return [];
                }

                const { fromSec, toSec, heard, choices } = question;
                return [{ fromSec, toSec, heard, readings: withConfidence(choices, question.confidence) }];
            }

            if (question.about !== "speaker") {
                return [];
            }

            return decided.flatMap((item) =>
                item.kind === "speaker-range" && item.status === "suggested" && !applied(item)
                    ? [
                          {
                              fromSec: item.fromSec,
                              toSec: item.toSec,
                              speaker: item.label,
                              readings: withConfidence(question.choices, item.confidence),
                          },
                      ]
                    : []
            );
        }),
        ...unaskedTerms,
        ...unaskedRanges,
    ];
}

/** The first reading is the rules' guess: it carries their confidence. The others have none of their own. */
function withConfidence(readings: string[], confidence: number | undefined): string[] {
    return readings.map((reading, index) =>
        index === 0 && confidence !== undefined ? `${reading} ${Math.round(confidence * 100)} %` : reading
    );
}

/** The line address an item carries: its index in the source transcript, stored by suggest and `items add`. */
export function lineOf(item: MeetingItem): number | undefined {
    const line = item.evidence?.transcriptLine;
    return typeof line === "number" && Number.isInteger(line) && line >= 0 ? line : undefined;
}

/**
 * What a transcript applies: renames, then the confirmed items, then the dictionary. With `withSuggested` a suggested
 * item is applied too when its confidence reaches `global.suggest.applyAbove` (one with no confidence, a person's
 * own, always); a lower one is marked unclear, as an open question is.
 */
export function correctionsOf(
    record: MeetingRecord,
    config: MeetingsConfig,
    opts: { withSuggested?: boolean; dictionary?: boolean; format: TranscriptFormat; include?: string[] }
): TranscriptCorrections {
    const applyAbove = config.global.suggest.applyAbove;
    const applies = (item: MeetingItem) =>
        item.status === "confirmed" ||
        (opts.include?.includes(item.id) === true && item.status !== "rejected") ||
        (opts.withSuggested === true &&
            item.status === "suggested" &&
            (item.confidence === undefined || item.confidence >= applyAbove));
    const used = record.items
        .filter(applies)
        .sort((a, b) => Number(a.status === "confirmed") - Number(b.status === "confirmed"));
    // A label that tracks no one person marks its lines unclear, last: a question or a range's own guess says more.
    const unlabeled = used.flatMap((item): UnclearPassage[] =>
        item.kind === "label" ? [{ fromSec: item.fromSec, toSec: item.toSec, speaker: item.label, readings: [] }] : []
    );
    const passages = [
        ...(opts.withSuggested
            ? unclearPassages(record, { below: applyAbove, applied: applies })
            : unclearPassages(record, { below: config.global.suggest.listenBelow })),
        ...unlabeled,
    ];

    const address = (item: MeetingItem) => {
        const line = lineOf(item);
        return line === undefined ? {} : { line };
    };
    const ranges = used.flatMap((item) =>
        item.kind === "speaker-range" && item.speaker
            ? [{ label: item.label, fromSec: item.fromSec, toSec: item.toSec, speaker: item.speaker, item: item.id }]
            : []
    );
    // A joined word makes the two lines one voice: the line before the cut takes the voice a range gives the line
    // after it, because joins apply before ranges and that range would no longer reach it.
    const voiceAt = (label: string, atSec: number) =>
        ranges.findLast(
            (range) =>
                range.label === label &&
                range.fromSec - LINE_AT_TOLERANCE_SEC <= atSec &&
                atSec <= range.toSec + LINE_AT_TOLERANCE_SEC
        )?.speaker;

    return {
        labels: record.speakers.labels,
        ranges,
        joins: used.flatMap((item) =>
            item.kind === "join"
                ? [
                      {
                          atSec: item.atSec,
                          ...address(item),
                          item: item.id,
                          ...(item.speaker ? { speaker: voiceAt(item.speaker, item.atSec) ?? item.speaker } : {}),
                          ...(item.joined ? { joined: item.joined } : {}),
                      },
                  ]
                : []
        ),
        terms: used.flatMap((item) =>
            item.kind === "term" && item.proposed && !item.meaning && !item.quote
                ? [
                      {
                          heard: item.heard,
                          replacement: item.proposed,
                          item: item.id,
                          ...(item.scope === "line" && item.atSec !== undefined
                              ? { atSec: item.atSec, ...address(item) }
                              : {}),
                      },
                  ]
                : []
        ),
        marks: used.flatMap((item) =>
            item.kind === "term" && item.atSec !== undefined && (item.meaning || item.quote)
                ? [
                      {
                          atSec: item.atSec,
                          ...address(item),
                          heard: item.heard,
                          item: item.id,
                          ...(item.meaning ? { meaning: item.meaning } : {}),
                          ...(item.quote ? { quote: item.quote } : {}),
                      },
                  ]
                : []
        ),
        ...(opts.dictionary === false
            ? {}
            : { dictionary: resolveDictionary(config, { project: record.project, meeting: record.dictionary }) }),
        notes: opts.format === "md" ? "sup" : "inline",
        ...(passages.length > 0 ? { unclear: { label: languageSettings(config).render.unclearLabel, passages } } : {}),
    };
}

/** What the transcript of a meeting is after its corrections, and what became of each item it applied. */
export interface CorrectedTranscript extends CorrectionsApplied {
    /** The people the lines are attributed to after the corrections, with their line counts, most lines first. */
    speakers: Array<{ name: string; lines: number }>;
    /** Source labels no correction named a person for (`Speaker 5`), with their line counts. */
    unattributed: Array<{ name: string; lines: number }>;
}

/**
 * The corrections pipeline: the record's decided items (with `withSuggested`, the suggested ones at or above
 * `global.suggest.applyAbove`; with `include`, these items whatever their confidence), the dictionary, and the open
 * questions, applied to the source transcript in their fixed order. Returns the corrected lines and one outcome per
 * item: applied to its lines, not found, ambiguous (two lines in one second), or shadowed by another item.
 */
export function correctTranscript(options: {
    record: MeetingRecord;
    transcript: TranscriptEntry[];
    config: MeetingsConfig;
    format: TranscriptFormat;
    withSuggested?: boolean;
    dictionary?: boolean;
    include?: string[];
}): CorrectedTranscript {
    const { record, transcript, config } = options;
    const corrections = correctionsOf(record, config, options);
    const applied = applyCorrections(transcript, corrections);
    const outcomes = [...applied.outcomes, ...labelOutcomes(record, transcript, applied.outcomes, corrections)];
    const unclear = `[${languageSettings(config).render.unclearLabel}:`;
    const sourceLabels = new Set(transcript.map((entry) => entry.speaker));
    const people = new Set([
        ...record.participants.map((person) => person.name),
        ...(record.attendance?.people.map((person) => person.name) ?? []),
        ...Object.values(record.speakers.labels),
    ]);
    const counts = new Map<string, number>();

    for (const entry of applied.entries) {
        if (!entry.speaker.startsWith(unclear)) {
            counts.set(entry.speaker, (counts.get(entry.speaker) ?? 0) + 1);
        }
    }

    const ranked = [...counts.entries()]
        .map(([name, lines]) => ({ name, lines }))
        .sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name));
    const isPerson = (name: string) => !sourceLabels.has(name) || people.has(name);

    return {
        ...applied,
        outcomes,
        speakers: ranked.filter((speaker) => isPerson(speaker.name)),
        unattributed: ranked.filter((speaker) => !isPerson(speaker.name)),
    };
}

/**
 * What became of each label item the corrections used: applied to its lines that no range or join gave a voice, shadowed
 * when those gave every one of them a voice, not found when the label has no line in the stretch.
 */
function labelOutcomes(
    record: MeetingRecord,
    transcript: TranscriptEntry[],
    outcomes: CorrectionOutcome[],
    corrections: TranscriptCorrections
): CorrectionOutcome[] {
    const lines = new TranscriptLines(transcript);
    const voiced = new Map<number, string>();

    const voiceItems = new Set(
        record.items
            .filter((item) => (item.kind === "speaker-range" || item.kind === "join") && item.speaker)
            .map((item) => item.id)
    );

    for (const outcome of outcomes) {
        if (outcome.status === "applied" && voiceItems.has(outcome.item)) {
            for (const line of outcome.lines) {
                voiced.set(line.index, outcome.item);
            }
        }
    }

    const passages = corrections.unclear?.passages ?? [];

    return record.items.flatMap((item): CorrectionOutcome[] => {
        const used =
            item.kind === "label" &&
            passages.some(
                (passage) =>
                    passage.speaker === item.label &&
                    passage.readings.length === 0 &&
                    passage.fromSec === item.fromSec &&
                    passage.toSec === item.toSec
            );

        if (item.kind !== "label" || !used) {
            return [];
        }

        const inside = transcript.flatMap((entry, index) =>
            entry.speaker === item.label &&
            entry.startSec !== undefined &&
            entry.startSec >= item.fromSec &&
            entry.startSec <= item.toSec
                ? [index]
                : []
        );

        if (inside.length === 0) {
            return [
                {
                    item: item.id,
                    status: "not-found",
                    reason: `no line of "${item.label}" from ${formatClock(item.fromSec)} to ${formatClock(item.toSec)}`,
                },
            ];
        }

        const open = inside.filter((index) => !voiced.has(index));

        if (open.length === 0) {
            const by = voiced.get(inside[0]!)!;
            return [{ item: item.id, status: "shadowed", by, reason: `${by} and other items gave every line a voice` }];
        }

        return [{ item: item.id, status: "applied", lines: open.flatMap((index) => lines.address(index) ?? []) }];
    });
}

/** `i42 did not apply: no "X" at 37:43`. Undefined for an item that applied. */
export function outcomeText(outcome: CorrectionOutcome): string | undefined {
    if (outcome.status === "applied") {
        return undefined;
    }

    const shown = outcome.status === "ambiguous" ? `${outcome.reason}; anchor it to one of them` : outcome.reason;
    return `${outcome.item} did not apply: ${shown}`;
}

/**
 * The ledger lines one decision writes for an item, from its entry before the decision (`prior`) and after it
 * (`next`): a retraction of the earlier confirmation when the decision changes it (a reject, another spelling or
 * speaker), then the new confirmation. The ledger is append-only, so without the retraction a rejected or respelled
 * confirmation kept counting as dictionary evidence.
 */
export function decisionLedger(prior: Correction | undefined, next: Correction | undefined): Correction[] {
    const same = (a: Correction, b: Correction) =>
        SafeJSON.stringify({ ...a, at: "" }) === SafeJSON.stringify({ ...b, at: "" });
    const lines: Correction[] = [];

    if (prior && !(next && same(prior, next))) {
        lines.push({ ...prior, retracted: true });
    }

    if (next) {
        lines.push(next);
    }

    return lines;
}

/**
 * The corrections-ledger entry a confirmed item writes: a term's spelling (`heard` → `fixed`) or a join's glued
 * word. Every path that confirms an item (`items confirm`, an answered question) writes it through here.
 */
export function ledgerEntryFor(record: MeetingRecord, item: MeetingItem, now: string): Correction | undefined {
    if (item.status !== "confirmed") {
        return undefined;
    }

    const base = { at: now, meeting: record.id, project: record.project, item: item.id };

    if (item.kind === "term" && item.proposed) {
        return { ...base, kind: "term", scope: item.scope ?? "everywhere", heard: item.heard, fixed: item.proposed };
    }

    if (item.kind === "join" && item.joined) {
        const evidence = item.evidence ?? {};
        const heard = [evidence.left, evidence.right].filter((part) => typeof part === "string").join(" ");
        return { ...base, kind: "join", heard, fixed: item.joined };
    }

    return undefined;
}

/**
 * Checks where an item is anchored: a join, or a term bound to one line, needs exactly one line at its time. Returns
 * a warning per item that names no line or two lines in one second, and the address of each item anchored to one.
 */
export function checkAnchors(
    items: MeetingItem[],
    transcript: TranscriptEntry[]
): { warnings: string[]; addresses: Map<string, number> } {
    const lines = new TranscriptLines(transcript);
    const warnings: string[] = [];
    const addresses = new Map<string, number>();

    for (const item of items) {
        const bound =
            item.kind === "join" || (item.kind === "term" && item.atSec !== undefined && item.scope === "line");
        const marked = item.kind === "term" && item.atSec !== undefined && (item.meaning || item.quote);

        if ((!bound && !marked) || (item.kind !== "join" && item.kind !== "term") || item.atSec === undefined) {
            continue;
        }

        const atSec = item.atSec;
        const heard = item.kind === "term" ? item.heard : undefined;
        const anchor = { atSec, line: lineOf(item) };
        const found =
            item.kind === "join"
                ? joinLine(lines, { ...anchor, ...(item.joined ? { joined: item.joined } : {}) })
                : heardLineAt(lines, anchor, item.heard);
        const at = formatClock(atSec);

        if (found.kind === "found") {
            if (anchor.line !== undefined && anchor.line !== found.index) {
                warnings.push(
                    `${item.id}: line ${anchor.line} does not start at ${at}; anchored to line ${found.index}`
                );
            }

            addresses.set(item.id, found.index);
            continue;
        }

        if (found.kind === "none") {
            warnings.push(`${item.id}: no line ${heard ? `with "${heard}" ` : ""}starts at ${at}`);
            continue;
        }

        const which = found.indexes
            .map((index) => `line ${index} "${(transcript[index]?.text ?? "").slice(0, 40)}"`)
            .join(", ");
        warnings.push(
            `${item.id}: ${found.indexes.length} lines start at ${at} (${which}); it will not apply until its finding names one with "line": <n>`
        );
    }

    return { warnings, addresses };
}
