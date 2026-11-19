import type { MeetingItem } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import type { IndicatorAssessment } from "./speaker-indicator";
import type { LineLabel } from "./speaker-labels/types";

/**
 * The one sentence table of the review rows (U9, U13, U17): the words a person reads for a speaker labeler's reason
 * code, a speaking indicator code and an item kind. A row never prints a code itself, and the window draws only what
 * this table says.
 */

/** What a labeler's reason is worded from: the item's evidence and the person it names. */
export interface ReasonEvidence {
    labeler?: string;
    reason?: string;
    /** The seat the line was heard on: `mic` or `call`. */
    seat?: string;
    /** Who the reason is about: the person the line is given to, or the seat's person a voice does not match. */
    person?: string;
    score?: number;
    next?: { person: string; score: number };
}

type LabelerReason = LineLabel["reason"];

/** A voice score as a row prints it: a cosine with two decimals, never a percent, because it is not a probability. */
export function voiceScoreText(score: number): string {
    return score.toFixed(2);
}

/** Every code of `LineLabel.reason`: the type makes the table name each one. */
const LABELER_REASON_WORDS: Record<LabelerReason, (evidence: ReasonEvidence) => string> = {
    named: ({ person, score, next }) =>
        `Sounds like ${person ?? "one of the people here"}` +
        (score === undefined ? "" : `: ${voiceScoreText(score)} match`) +
        (next ? `, next closest ${next.person} ${voiceScoreText(next.score)}` : ""),
    exclusion: ({ person }) =>
        `No saved voice fits, and ${person ?? "one person here"} is the only one without a sample, so the line is likely theirs`,
    "exclusion-not-one-voice": () =>
        "No saved voice fits these lines, and they do not sound like one person, so they stay open",
    "exclusion-too-few-lines": () =>
        "No saved voice fits, but too few such lines are known to give them to the one person without a sample",
    "below-gate": () => "The voice is too weak a match, or too close to the next person, to say who it is",
    "no-rival-sample": () => "Only one person here has voice samples, and the match is not close enough",
    "unsampled-present": ({ person, next }) => {
        const waiting = next?.person ?? person;
        return waiting ? `Waits for a voice sample of ${waiting}` : "Waits for a voice sample of somebody here";
    },
    "not-the-seat-person": ({ person, next }) =>
        `Does not sound like ${person ?? next?.person ?? "the person at this seat"}`,
    "no-voice": () => "The line is too short or has no clear voice to compare",
    "seat-of-one": ({ person }) => `Only ${person ?? "one person"} sat at this seat, so the line is theirs`,
    "seat-shared": () => "Several people share this seat, so the seat alone does not say who spoke",
    "seat-unknown": () => "Nobody is known to sit at this seat",
};

function isLabelerReason(reason: string): reason is LabelerReason {
    return Object.hasOwn(LABELER_REASON_WORDS, reason);
}

export const LABELER_REASON_CODES: readonly LabelerReason[] = Object.keys(LABELER_REASON_WORDS).filter(isLabelerReason);

/**
 * A labeler's reason code in words ("Only Alice Example sat at this seat, so the line is theirs"); nothing for any
 * other text, such as an agent's own reason, which a row prints as it is.
 */
export function labelerReasonSentence(evidence: ReasonEvidence): string | undefined {
    const reason = evidence.reason;
    return reason !== undefined && isLabelerReason(reason) ? LABELER_REASON_WORDS[reason](evidence) : undefined;
}

type IndicatorReason = IndicatorAssessment["reasons"] extends Map<number, infer Reason> ? Reason : never;

const INDICATOR_WORDS: Record<IndicatorReason, string> = {
    "meeting-dominance": "Speaking indicator ignored: it showed one name for most of the meeting",
    "stretch-stuck": "Speaking indicator ignored: it stayed on one name through a long stretch",
};

function isIndicatorReason(reason: string): reason is IndicatorReason {
    return Object.hasOwn(INDICATOR_WORDS, reason);
}

/** Why the call's speaking indicator was ignored on a line, in words. */
export function indicatorIgnoredSentence(reason: string): string {
    return isIndicatorReason(reason) ? INDICATOR_WORDS[reason] : "Speaking indicator ignored on this line";
}

const KIND_WORDS: Record<MeetingItem["kind"], string> = {
    "speaker-range": "Speaker range",
    label: "Unreliable label",
    removal: "Local speech output",
    join: "Join lines",
    term: "Spelling",
    question: "Question",
};

/** An item kind in words, as every row, pin and notice names it. */
export function itemKindWord(kind: MeetingItem["kind"]): string {
    return KIND_WORDS[kind];
}

/** The short rule ids (`RA`, `R18`, `E1`): a person never reads them. */
const RULE_IDS = Object.values(MeetingRule).filter((id) => /^[A-Z]{1,2}\d*$/u.test(id));
const RULE_ID_TOKEN = new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${RULE_IDS.join("|")})(?![\\p{L}\\p{N}_-])`, "u");
/** A labeler code with a hyphen (`seat-of-one`), as a whole token. */
const LABELER_CODE_TOKEN = new RegExp(
    `(?<![\\p{L}\\p{N}_-])(?:${LABELER_REASON_CODES.filter((code) => code.includes("-")).join("|")})(?![\\p{L}\\p{N}_-])`,
    "u"
);
/**
 * A field of the record or of `evidence --raw` (`meeting.indicatorGaps`, `evidence.reason`): a root the record has, or
 * a dotted name whose last part is camelCase. A package name (`@org.example.api`) or a file (`page.html`) is neither.
 */
const FIELD_NAME =
    /(?<![\p{L}\p{N}_@./-])(?:(?:meeting|record|item|items|evidence|seats|speakers|participants|transcript|decision)\.[A-Za-z]|[a-z][A-Za-z]*(?:\.[A-Za-z]+)*\.[a-z]+[A-Z][A-Za-z]*)/u;

/** Whether a reason names a field, a rule id or a labeler code instead of saying it in words (U18). */
export function hasCodeWord(text: string): boolean {
    return FIELD_NAME.test(text) || RULE_ID_TOKEN.test(text) || LABELER_CODE_TOKEN.test(text);
}
