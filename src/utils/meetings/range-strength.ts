import type { MeetingItem } from "./record";
import { MeetingRule } from "./rules";

/**
 * How strongly a speaker range states its name, whatever its age. A person's confirmation outranks a range built on
 * the user's answer (its rules include the user's rule), that outranks a range an agent stated (`items add`), and that
 * outranks a rule's automatic finding (the seat, the voice).
 */
export enum RangeStrength {
    Automatic = 0,
    Stated = 1,
    UserDerived = 2,
    Confirmed = 3,
}

type Ranked = Pick<MeetingItem, "status" | "rules" | "confidence">;
type Evidenced = Pick<MeetingItem, "rules" | "evidence">;

/**
 * What a speaker range's name rests on. Rules that read the same thing are one source, so their agreement never adds
 * up: the seat, the channel and the energy rules all read the recording's two audio levels. A voice finding counts
 * only when it compared the person with a rival (`evidence.next`, or the enrolment rule's own margin). Measured on
 * the lines people decided, with each meeting's own samples left out (2026-11-25): a voice name with a rival was
 * right on 20 of 21 lines, a name with no rival to compare on 11 of 20.
 */
export const EVIDENCE_SOURCES = ["levels", "voice", "platform", "words", "agent", "user"] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

const RULE_SOURCES: ReadonlyMap<string, EvidenceSource> = new Map<string, EvidenceSource>([
    [MeetingRule.Channel, "levels"],
    [MeetingRule.Energy, "levels"],
    [MeetingRule.LocalVoice, "levels"],
    [MeetingRule.LabelVoice, "levels"],
    [MeetingRule.LabelSwap, "levels"],
    [MeetingRule.SpeakingIndicator, "platform"],
    [MeetingRule.LiveName, "platform"],
    [MeetingRule.Muted, "platform"],
    [MeetingRule.PlatformPrehistory, "platform"],
    [MeetingRule.LeavePhrase, "words"],
    [MeetingRule.ContinuesAfterLeave, "words"],
    [MeetingRule.FarewellAnswered, "words"],
    [MeetingRule.EchoedFarewell, "words"],
    [MeetingRule.Arrival, "words"],
    [MeetingRule.OwnLabel, "words"],
    [MeetingRule.Agent, "agent"],
    [MeetingRule.User, "user"],
]);

/** The kinds of evidence behind a range, in the order of `EVIDENCE_SOURCES`; a rule this build does not know adds none. */
export function evidenceSources(item: Evidenced): EvidenceSource[] {
    const found = new Set<EvidenceSource>();

    for (const rule of item.rules) {
        if (rule === MeetingRule.Attendance) {
            // The seat labeler writes this rule from the side of the recording a line is on; the rule itself reads the roster.
            found.add(item.evidence?.labeler === "seat" ? "levels" : "platform");
        } else if (
            rule === MeetingRule.Voice ||
            (rule === MeetingRule.VoiceEmbedding && item.evidence?.next !== undefined)
        ) {
            found.add("voice");
        } else {
            const source = RULE_SOURCES.get(rule);

            if (source) {
                found.add(source);
            }
        }
    }

    return EVIDENCE_SOURCES.filter((source) => found.has(source));
}

/** Findings that agree never reach certainty: a person still confirms. */
export const FUSED_MAX = 0.95;

/**
 * One confidence for findings that name the same person and rest on different evidence: `1 - (1 - a)(1 - b)…`
 * (noisy-OR), to two decimals and at most `FUSED_MAX`. A single finding keeps its own value, and agreement never
 * lowers the strongest one.
 */
export function fuseConfidence(confidences: readonly number[]): number {
    const strongest = Math.max(0, ...confidences);

    if (confidences.length < 2) {
        return strongest;
    }

    const doubt = confidences.reduce((left, confidence) => left * (1 - confidence), 1);
    return Math.max(strongest, Math.min(FUSED_MAX, Math.round((1 - doubt) * 100) / 100));
}

/** A finding that agrees with a range: the evidence it rests on and its confidence. */
export interface AgreeingFinding {
    sources: readonly string[];
    confidence: number;
}

/** The key of one agreeing finding in `evidence.agreeing`: its sources, joined. */
export function agreeingKey(sources: readonly string[]): string {
    return [...sources].sort().join("+");
}

/**
 * The findings a pass recorded as agreeing with a range (`evidence.agreeing`: sources joined by `+`, then the
 * confidence): other findings for the same person on the same line. An unreadable entry is no finding.
 */
export function agreeingFindings(item: Pick<MeetingItem, "evidence">): AgreeingFinding[] {
    const saved = item.evidence?.agreeing;

    if (typeof saved !== "object" || saved === null || Array.isArray(saved)) {
        return [];
    }

    return Object.entries(saved).flatMap(([key, confidence]) =>
        typeof confidence === "number" && confidence > 0 && confidence <= 1
            ? [{ sources: key.split("+"), confidence }]
            : []
    );
}

/**
 * A range's confidence together with the findings that agree with it. Each finding counts once, strongest first, and
 * only when its evidence shares nothing with the range's own evidence or with a finding already counted, so one
 * reading never adds up twice. A range with no recorded agreement keeps its own confidence.
 */
export function fusedConfidence(item: Pick<MeetingItem, "rules" | "evidence" | "confidence">): number | undefined {
    if (item.confidence === undefined) {
        return undefined;
    }

    const counted = new Set<string>(evidenceSources(item));
    const confidences = [item.confidence];

    for (const finding of agreeingFindings(item).sort((a, b) => b.confidence - a.confidence)) {
        if (finding.sources.some((source) => counted.has(source))) {
            continue;
        }

        confidences.push(finding.confidence);

        for (const source of finding.sources) {
            counted.add(source);
        }
    }

    return fuseConfidence(confidences);
}

export function rangeStrength(item: Pick<MeetingItem, "status" | "rules">): RangeStrength {
    if (item.status === "confirmed") {
        return RangeStrength.Confirmed;
    }

    // An answer the user gave, or one carried to a similar line, appends the user's rule to the range it decides.
    if (item.rules.includes(MeetingRule.User)) {
        return RangeStrength.UserDerived;
    }

    // Rules are only ever appended, so the first one made the range: `items add` makes it with the agent's rule. A pass
    // keeps the rules of the ranges it agreed or conflicted with, so a later agent rule does not say who named it.
    return item.rules[0] === MeetingRule.Agent ? RangeStrength.Stated : RangeStrength.Automatic;
}

/**
 * Whether a suggested range takes part in naming its line at any confidence, so the order (`compareRanges`) decides
 * between it and the other ranges on that line: one built on the user's answer or stated by an agent does. A rule's
 * range under the apply threshold does not; it stays a guess where nothing stronger names the line.
 */
export function namesAtAnyConfidence(item: Pick<MeetingItem, "status" | "rules">): boolean {
    return rangeStrength(item) !== RangeStrength.Automatic;
}

/**
 * Whether the name a range gives its line came from the voice: a voice rule made the range and nobody stated or
 * answered it since. A range built on the user's answer or stated by an agent may carry the voice rule too (a voice
 * suggestion the user then answered), but the name is theirs, so the line says nothing about a voice.
 */
export function namedByVoice(item: Pick<MeetingItem, "status" | "rules">): boolean {
    return item.rules.includes(MeetingRule.VoiceEmbedding) && rangeStrength(item) === RangeStrength.Automatic;
}

/**
 * Whether the range that names a line shows its name as a guess (`[Name: 60 %]`): an agent's stated range or a rule's
 * range under the apply threshold. A confirmed range and one built on the user's answer show the name plainly at any
 * confidence, because the user decided it; an agent's confidence is its own doubt, and a plain name would hide it.
 * With `fused`, the range's confidence counts the findings that agree with it (`fusedConfidence`).
 */
export function showsAsGuess(
    item: Ranked & Pick<MeetingItem, "evidence">,
    applyAbove: number,
    options: { fused?: boolean } = {}
): boolean {
    const strength = rangeStrength(item);

    if (strength === RangeStrength.Confirmed || strength === RangeStrength.UserDerived) {
        return false;
    }

    const confidence = options.fused ? fusedConfidence(item) : item.confidence;
    return confidence !== undefined && confidence < applyAbove;
}

/**
 * Below zero when `a` names a line less strongly than `b`, zero for equals (the later of equals wins). The stronger
 * kind wins; within a kind the higher confidence wins (a range with none is its author's certainty), except among
 * confirmed ranges, where a person's later decision replaces the earlier one.
 */
export function compareRanges(a: Ranked, b: Ranked): number {
    const strength = rangeStrength(a) - rangeStrength(b);

    if (strength !== 0 || rangeStrength(a) === RangeStrength.Confirmed) {
        return strength;
    }

    return (a.confidence ?? 1) - (b.confidence ?? 1);
}

/**
 * The range that names a line: the strongest (`compareRanges`), and the latest of equals (a record keeps its items in
 * the order added).
 */
export function strongestRange<T extends Ranked>(ranges: readonly T[]): T | undefined {
    let best: T | undefined;

    for (const range of ranges) {
        if (!best || compareRanges(range, best) >= 0) {
            best = range;
        }
    }

    return best;
}

/** The ranges weakest first, equals in their own order: for a reader where the last range applied names the line. */
export function weakestFirst<T extends Ranked>(ranges: readonly T[]): T[] {
    return [...ranges].sort(compareRanges);
}

/** The ranges strongest first, the later of equals first: for a reader where the first range marks the line. */
export function strongestFirst<T extends Ranked>(ranges: readonly T[]): T[] {
    return weakestFirst(ranges).reverse();
}
