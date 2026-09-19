import { elementLabel, type Observation, type ObservedElement } from "../decision/observation";
import type { IdbElement } from "./idb";

/**
 * What makes an element the same element across two reads of the screen. The app's own
 * accessibility identifier when it set one, otherwise role plus visible label — never the index,
 * which renumbers whenever anything above it appears or leaves.
 */
export function elementSignature(row: ObservedElement): string {
    return row.AXIdentifier ? `id:${row.AXIdentifier}` : `role:${row.role}|label:${elementLabel(row)}`;
}

/** The signature of whatever idb reports at a hit-tested point. */
export function probedSignature(present: IdbElement): string {
    return elementSignature({
        index: 0,
        depth: 0,
        role: present.role?.startsWith("AX") ? present.role : `AX${present.type ?? "Unknown"}`,
        ...(present.AXUniqueId ? { AXIdentifier: present.AXUniqueId } : {}),
        ...(present.AXLabel ? { AXDescription: present.AXLabel } : {}),
    });
}

/**
 * Compares the element decided on against the element actually occupying the point about to be
 * acted on. Returns the reason to refuse, or `undefined` when they are the same element. This is
 * the simulator's equivalent of the macOS snapshot digest: the guarantee that a decision is never
 * dispatched at coordinates that changed meaning while the model was deciding.
 */
export function staleRefusalReason(target: ObservedElement, present: IdbElement | undefined): string | undefined {
    if (!present) {
        return "the simulator could not describe the point about to be acted on";
    }
    const expected = elementSignature(target);
    const actual = probedSignature(present);
    return expected === actual ? undefined : `the screen moved: ${expected} was decided on, ${actual} is there now`;
}

export interface Rematch {
    row: ObservedElement;
    /** True when the element also sits where it sat before, within `tolerancePoints`. */
    moved: boolean;
}

function frameOf(row: ObservedElement): { x: number; y: number } | undefined {
    return typeof row.x === "number" && typeof row.y === "number" ? { x: Number(row.x), y: Number(row.y) } : undefined;
}

/**
 * Finds the chosen element again in a FRESH observation. A decision made against a screen that has
 * since moved is discarded here rather than dispatched at whatever now occupies those coordinates.
 */
export function rematchElement(options: {
    chosen: ObservedElement;
    fresh: Observation;
    tolerancePoints?: number;
}): Rematch {
    const signature = elementSignature(options.chosen);
    const matches = options.fresh.elements.filter((row) => elementSignature(row) === signature);
    if (matches.length === 0) {
        throw new Error(
            `The chosen element (${signature}) is no longer on screen. The screen moved while the decision was being made; observe again.`
        );
    }
    const before = frameOf(options.chosen);
    if (matches.length > 1) {
        if (!before) {
            throw new Error(`The chosen element (${signature}) is now ambiguous: ${matches.length} matches.`);
        }
        const tolerance = options.tolerancePoints ?? 8;
        const near = matches.filter((row) => {
            const after = frameOf(row);
            return (
                after !== undefined &&
                Math.abs(after.x - before.x) <= tolerance &&
                Math.abs(after.y - before.y) <= tolerance
            );
        });
        if (near.length !== 1) {
            throw new Error(`The chosen element (${signature}) is now ambiguous: ${matches.length} matches.`);
        }
        return { row: near[0], moved: false };
    }
    const after = frameOf(matches[0]);
    const tolerance = options.tolerancePoints ?? 8;
    const moved =
        before !== undefined &&
        after !== undefined &&
        (Math.abs(after.x - before.x) > tolerance || Math.abs(after.y - before.y) > tolerance);
    return { row: matches[0], moved };
}
