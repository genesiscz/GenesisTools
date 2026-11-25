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
 */
export function showsAsGuess(item: Ranked, applyAbove: number): boolean {
    const strength = rangeStrength(item);

    if (strength === RangeStrength.Confirmed || strength === RangeStrength.UserDerived) {
        return false;
    }

    return item.confidence !== undefined && item.confidence < applyAbove;
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
