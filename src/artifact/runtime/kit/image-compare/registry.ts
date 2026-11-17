import { blinkMode } from "./modes/blink";
import { diffMode } from "./modes/diff";
import { fadeMode } from "./modes/fade";
import { heatMode } from "./modes/heat";
import { sideBySideMode } from "./modes/side-by-side";
import { sliderMode } from "./modes/slider";
import type { CompareMode } from "./stage";

/** Every mode in switch order: the only place that lists them. A new mode is one file in `modes/` and one line here. */
export const COMPARE_MODES: readonly CompareMode[] = [
    sideBySideMode,
    sliderMode,
    blinkMode,
    fadeMode,
    diffMode,
    heatMode,
];

/** The mode a comparison shows when nothing else picks one. */
export const DEFAULT_COMPARE_MODE = sideBySideMode.id;

export function findCompareMode(id: string | undefined): CompareMode | undefined {
    return COMPARE_MODES.find((mode) => mode.id === id);
}

function unknownMode(id: string, prop: string): Error {
    return new Error(
        `ImageCompare: unknown mode "${id}" in \`${prop}\`. Known modes: ${COMPARE_MODES.map((mode) => mode.id).join(", ")}.`
    );
}

/** The modes a comparison offers, in registry order; every id must be registered. Default: all of them. */
export function compareModesFor(ids: readonly string[] | undefined): CompareMode[] {
    if (ids === undefined) {
        return [...COMPARE_MODES];
    }

    for (const id of ids) {
        if (!findCompareMode(id)) {
            throw unknownMode(id, "modes");
        }
    }

    if (ids.length === 0) {
        throw new Error("ImageCompare: `modes` needs at least one mode.");
    }

    return COMPARE_MODES.filter((mode) => ids.includes(mode.id));
}

/** Throws when an author's default names a mode that is not registered. */
export function checkModeId(id: string | undefined, prop: string): void {
    if (id !== undefined && !findCompareMode(id)) {
        throw unknownMode(id, prop);
    }
}
