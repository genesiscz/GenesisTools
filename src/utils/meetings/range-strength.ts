import type { MeetingItem } from "./record";
import { MeetingRule } from "./rules";

/**
 * How strongly a speaker range states its name. A person's confirmation outranks a range that a person or an agent
 * stated (`items add`, a listen answer), and that outranks a rule's automatic finding (the seat, the voice, an answer
 * carried to another line by its signature), whatever their age.
 */
export enum RangeStrength {
    Automatic = 0,
    Stated = 1,
    Confirmed = 2,
}

type Ranked = Pick<MeetingItem, "status" | "rules">;

export function rangeStrength(item: Ranked): RangeStrength {
    if (item.status === "confirmed") {
        return RangeStrength.Confirmed;
    }

    // Rules are only ever appended, so the first one made the range: `items add` and an answer make theirs with the
    // agent's or the user's rule. A pass keeps the rules of the ranges it agreed or conflicted with, and an answer
    // carried to a similar line appends the user's rule, so a later agent or user rule does not say who named it.
    const first = item.rules[0];
    return first === MeetingRule.Agent || first === MeetingRule.User ? RangeStrength.Stated : RangeStrength.Automatic;
}

/** The range that names a line: the strongest, and the latest of equals (a record keeps its items in the order added). */
export function strongestRange<T extends Ranked>(ranges: readonly T[]): T | undefined {
    let best: T | undefined;
    let bestStrength = RangeStrength.Automatic;

    for (const range of ranges) {
        const strength = rangeStrength(range);

        if (!best || strength >= bestStrength) {
            best = range;
            bestStrength = strength;
        }
    }

    return best;
}

/** The ranges weakest first, equals in their own order: for a reader where the last range applied names the line. */
export function weakestFirst<T extends Ranked>(ranges: readonly T[]): T[] {
    return [...ranges].sort((a, b) => rangeStrength(a) - rangeStrength(b));
}

/** The ranges strongest first, equals in their own order: for a reader where the first range marks the line. */
export function strongestFirst<T extends Ranked>(ranges: readonly T[]): T[] {
    return [...ranges].sort((a, b) => rangeStrength(b) - rangeStrength(a));
}
