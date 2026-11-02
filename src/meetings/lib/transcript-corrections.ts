import { type MeetingsConfig, resolveDictionary } from "@genesiscz/utils/meetings/config";
import type { MeetingItem, MeetingRecord } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import type { TranscriptCorrections, UnclearPassage } from "@genesiscz/utils/transcribe/apply";
import type { TranscriptFormat } from "@genesiscz/utils/transcribe/render";
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
                      fromSec: 0,
                      toSec: Number.POSITIVE_INFINITY,
                      heard: item.heard,
                      readings: withConfidence([item.proposed], item.confidence),
                  },
              ]
            : []
    );
    const unaskedRanges = opts.applied
        ? record.items.flatMap((item): UnclearPassage[] =>
              item.kind === "speaker-range" && unaskedLow(item)
                  ? [
                        {
                            fromSec: item.fromSec,
                            toSec: item.toSec,
                            speaker: item.label,
                            readings: withConfidence(
                                item.speaker ? [item.speaker] : (item.candidates ?? []),
                                item.confidence
                            ),
                        },
                    ]
                  : []
          )
        : [];

    return [
        ...unaskedTerms,
        ...unaskedRanges,
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
    ];
}

/** The first reading is the rules' guess: it carries their confidence. The others have none of their own. */
function withConfidence(readings: string[], confidence: number | undefined): string[] {
    return readings.map((reading, index) =>
        index === 0 && confidence !== undefined ? `${reading} ${Math.round(confidence * 100)} %` : reading
    );
}

/**
 * What a transcript applies: renames, then the confirmed items, then the dictionary. With `withSuggested` a suggested
 * item is applied too when its confidence reaches `global.suggest.applyAbove` (one with no confidence, a person's
 * own, always); a lower one is marked unclear, as an open question is.
 */
export function correctionsOf(
    record: MeetingRecord,
    config: MeetingsConfig,
    opts: { withSuggested?: boolean; dictionary?: boolean; format: TranscriptFormat }
): TranscriptCorrections {
    const applyAbove = config.global.suggest.applyAbove;
    const applies = (item: MeetingItem) =>
        item.status === "confirmed" ||
        (opts.withSuggested === true &&
            item.status === "suggested" &&
            (item.confidence === undefined || item.confidence >= applyAbove));
    const used = record.items.filter(applies);
    const passages = opts.withSuggested
        ? unclearPassages(record, { below: applyAbove, applied: applies })
        : unclearPassages(record, { below: config.global.suggest.listenBelow });

    return {
        labels: record.speakers.labels,
        ranges: used.flatMap((item) =>
            item.kind === "speaker-range" && item.speaker
                ? [{ label: item.label, fromSec: item.fromSec, toSec: item.toSec, speaker: item.speaker }]
                : []
        ),
        joins: used.flatMap((item) =>
            item.kind === "join" ? [{ atSec: item.atSec, ...(item.speaker ? { speaker: item.speaker } : {}) }] : []
        ),
        terms: used.flatMap((item) =>
            item.kind === "term" && item.proposed ? [{ heard: item.heard, replacement: item.proposed }] : []
        ),
        ...(opts.dictionary === false
            ? {}
            : { dictionary: resolveDictionary(config, { project: record.project, meeting: record.dictionary }) }),
        notes: opts.format === "md" ? "sup" : "inline",
        ...(passages.length > 0 ? { unclear: { label: config.global.render.unclearLabel, passages } } : {}),
    };
}
