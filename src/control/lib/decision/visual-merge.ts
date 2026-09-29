import { candidatesFor, elementLabel, type Observation } from "./observation";

interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** An OCR region that an actionable AX element already represents. */
export interface RegionCover {
    element: number;
    reason: "overlap" | "icon";
}

/** Intersection over the SMALLER box, so a tight control inside a wide text line still counts. */
const MIN_BOX_OVERLAP = 0.5;
const HAS_WORD = /[\p{L}\p{N}]/u;

function rectOf(row: Observation["elements"][number]): Rect | undefined {
    const { x, y, width, height } = row;
    if ([x, y, width, height].every((value) => typeof value === "number" && Number.isFinite(value))) {
        const rect = { x: Number(x), y: Number(y), width: Number(width), height: Number(height) };
        return rect.width > 0 && rect.height > 0 ? rect : undefined;
    }

    return undefined;
}

function overlap(a: Rect, b: Rect): number {
    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    if (width <= 0 || height <= 0) {
        return 0;
    }

    return (width * height) / Math.min(a.width * a.height, b.width * b.height);
}

function words(text: string): string[] {
    return text
        .toLocaleLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length > 0);
}

/** The same label: one contains the other, or at least half of the shorter one's words are shared. */
export function textsMatch(a: string, b: string): boolean {
    const left = words(a);
    const right = words(b);
    if (left.length === 0 || right.length === 0) {
        return false;
    }

    const joinedLeft = left.join(" ");
    const joinedRight = right.join(" ");
    if (joinedLeft.includes(joinedRight) || joinedRight.includes(joinedLeft)) {
        return true;
    }

    const [shorter, longer] = left.length <= right.length ? [left, new Set(right)] : [right, new Set(left)];
    return shorter.filter((word) => longer.has(word)).length * 2 >= shorter.length;
}

/**
 * Which OCR regions an actionable AX element already names, so a caller can press the element
 * through AX instead of clicking pixels, and a chooser is not offered the same control twice.
 * Ported from typesafe-computer-use `merge_with_origins` and `is_icon`: a region counts when it
 * overlaps the element by at least half of the smaller box and its text matches the element's
 * label, or when it is a glyph with no letters or digits (`←`, `☆`) centred on the element.
 */
export function regionsCoveredByElements(options: {
    observation: Observation;
    regions: Array<{ id: string; text: string; screen: Rect }>;
}): Map<string, RegionCover> {
    const actionable = new Set(
        [
            ...candidatesFor({ observation: options.observation, action: "press" }),
            ...candidatesFor({ observation: options.observation, action: "set" }),
        ].map((candidate) => candidate.element)
    );
    const controls = options.observation.elements.flatMap((row) => {
        const rect = actionable.has(row.index) ? rectOf(row) : undefined;
        return rect ? [{ row, rect, label: elementLabel(row) }] : [];
    });
    const covered = new Map<string, RegionCover>();
    for (const region of options.regions) {
        const glyph = !HAS_WORD.test(region.text);
        const centre = { x: region.screen.x + region.screen.width / 2, y: region.screen.y + region.screen.height / 2 };
        const match = controls.find(({ rect, label }) => {
            if (glyph) {
                return (
                    centre.x >= rect.x &&
                    centre.x <= rect.x + rect.width &&
                    centre.y >= rect.y &&
                    centre.y <= rect.y + rect.height
                );
            }

            return overlap(region.screen, rect) >= MIN_BOX_OVERLAP && textsMatch(region.text, label);
        });
        if (match) {
            covered.set(region.id, { element: match.row.index, reason: glyph ? "icon" : "overlap" });
        }
    }

    return covered;
}
