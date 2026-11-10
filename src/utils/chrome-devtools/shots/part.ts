/**
 * One part of an annotated page shot: where to go, what to wait for and click, what to crop, and what to mark.
 * A mark is an annotation of `image/annotation-plan.ts` whose rectangle is a locator; the words of the first shot
 * script (`at: "below"`, `dx`, `dy`, `color`, `quiet`, a string label) are accepted and turned into that model here,
 * at the boundary, so nothing after it knows them.
 */
import {
    isPresetName,
    LABEL_POSITIONS,
    type LabelPosition,
    type PresetName,
    type ShapeLabel,
    type ShapeStyle,
} from "@genesiscz/utils/image/annotation-plan";
import { type Locator, type LocatorSource, parseLocator } from "./locator.ts";

/** The first script's label sides. */
export type ScriptSide = "above" | "below" | "left" | "right" | "inside";
export type ScriptColor = "red" | "amber";
export type MarkKind = "highlight" | "box" | "ellipse";

export interface MarkInput {
    target: LocatorSource;
    kind?: MarkKind;
    label?: string | ShapeLabel;
    preset?: PresetName;
    style?: ShapeStyle;
    /** The script's words: a side (above = top-left, below = bottom-left), a nudge, a color, a label without a box. */
    at?: ScriptSide | LabelPosition;
    dx?: number;
    dy?: number;
    color?: ScriptColor;
    quiet?: boolean;
}

export type StepInput =
    | { click: LocatorSource }
    | { scroll: LocatorSource }
    | { until: LocatorSource }
    | { wait: number };

export interface ClipInput {
    /** Default: the union of every mark's target. */
    around?: LocatorSource;
    /** Pixels around the union: one number, or [top, right, bottom, left]. Default 20. */
    pad?: number | readonly [number, number, number, number];
    /** The full width of the page (or of the viewport) instead of the width of `around`. */
    wide?: boolean;
    /** Crop from the viewport (a dialog), not from the whole page. */
    viewport?: boolean;
    /** "labels": grow the clip until every placed label is inside it. */
    fit?: "labels";
}

export interface PartInput {
    /** Relative to the book's base; omitted: shoot the tab as it is. */
    url?: string;
    ready?: LocatorSource;
    steps?: readonly StepInput[];
    clip?: ClipInput;
    /** The script's name for `clip.viewport`. */
    viewportOnly?: boolean;
    marks?: readonly MarkInput[];
}

export interface Mark {
    kind: MarkKind;
    target: Locator;
    label?: ShapeLabel;
    preset?: PresetName;
    style?: ShapeStyle;
}

export type Step = { click: Locator } | { scroll: Locator } | { until: Locator } | { wait: number };

export interface Clip {
    around: Locator;
    pad: [top: number, right: number, bottom: number, left: number];
    wide: boolean;
    viewport: boolean;
    fitLabels: boolean;
}

export interface ShotPart {
    url?: string;
    ready?: Locator;
    steps: Step[];
    clip: Clip;
    marks: Mark[];
}

export interface PartDefaults {
    /** The book's look; a red mark of the script takes it. */
    preset: PresetName;
    /** The preset an amber mark of the script takes. */
    amberPreset: PresetName;
    pad: number;
}

export const PART_DEFAULTS: PartDefaults = { preset: "review-dashed", amberPreset: "callout-amber-dashed", pad: 20 };

export class ShotPartError extends Error {
    override name = "ShotPartError";
}

const SCRIPT_SIDES: Record<ScriptSide, LabelPosition> = {
    above: "top-left",
    below: "bottom-left",
    left: "left",
    right: "right",
    inside: "inside",
};

function isScriptSide(value: string): value is ScriptSide {
    return value in SCRIPT_SIDES;
}

function sideOf(at: MarkInput["at"], path: string): LabelPosition | undefined {
    if (at === undefined) {
        return undefined;
    }

    if (isScriptSide(at)) {
        return SCRIPT_SIDES[at];
    }

    const position = LABEL_POSITIONS.find((known) => known === at);
    if (!position) {
        throw new ShotPartError(`${path}.at: unknown side "${at}"`);
    }

    return position;
}

function parseMark(input: MarkInput, defaults: PartDefaults, path: string): Mark {
    const label: ShapeLabel | undefined = typeof input.label === "string" ? { text: input.label } : input.label;
    const position = sideOf(input.at, path) ?? label?.position;
    const nudged = input.dx !== undefined || input.dy !== undefined;
    const preset = input.preset ?? (input.color === "amber" ? defaults.amberPreset : undefined);
    if (preset !== undefined && !isPresetName(preset)) {
        throw new ShotPartError(`${path}.preset: unknown preset "${preset}"`);
    }

    const mark: Mark = { kind: input.kind ?? "highlight", target: parseLocator(input.target) };
    if (label) {
        mark.label = {
            ...label,
            ...(position ? { position } : {}),
            ...(nudged ? { offset: { x: input.dx ?? 0, y: input.dy ?? 0 } } : {}),
        };
    }

    if (preset) {
        mark.preset = preset;
    }

    const style = input.quiet ? { ...input.style, strokeWidth: 0, fill: "" } : input.style;
    if (style) {
        mark.style = style;
    }

    return mark;
}

function parseStep(input: StepInput, path: string): Step {
    if ("click" in input) {
        return { click: parseLocator(input.click) };
    }

    if ("scroll" in input) {
        return { scroll: parseLocator(input.scroll) };
    }

    if ("until" in input) {
        return { until: parseLocator(input.until) };
    }

    if ("wait" in input && Number.isFinite(input.wait) && input.wait >= 0) {
        return { wait: input.wait };
    }

    throw new ShotPartError(`${path}: a step is { click }, { scroll }, { until } or { wait: ms }`);
}

function padOf(pad: ClipInput["pad"], fallback: number, path: string): Clip["pad"] {
    if (pad === undefined) {
        return [fallback, fallback, fallback, fallback];
    }

    const sides = typeof pad === "number" ? [pad, pad, pad, pad] : [...pad];
    if (sides.length !== 4 || sides.some((side) => !Number.isFinite(side) || side < 0)) {
        throw new ShotPartError(`${path}.pad: one number or [top, right, bottom, left], each 0 or more`);
    }

    return [sides[0], sides[1], sides[2], sides[3]];
}

/** Parses every locator once and fills the defaults; a bad field fails with its path. */
export function parseShotPart(input: PartInput, defaults: PartDefaults = PART_DEFAULTS, path = "part"): ShotPart {
    const marks = (input.marks ?? []).map((mark, index) => parseMark(mark, defaults, `${path}.marks[${index}]`));
    const around = input.clip?.around;
    if (around === undefined && marks.length === 0) {
        throw new ShotPartError(`${path}.clip.around: a part with no marks needs a clip`);
    }

    const clip: Clip = {
        around:
            around === undefined
                ? parseLocator(marks.flatMap((mark) => mark.target.chains.map((chain) => chain.source)))
                : parseLocator(around),
        pad: padOf(input.clip?.pad, defaults.pad, `${path}.clip`),
        wide: input.clip?.wide ?? false,
        viewport: input.clip?.viewport ?? input.viewportOnly ?? false,
        fitLabels: input.clip?.fit === "labels",
    };
    const part: ShotPart = {
        steps: (input.steps ?? []).map((step, index) => parseStep(step, `${path}.steps[${index}]`)),
        clip,
        marks,
    };
    if (input.url !== undefined) {
        part.url = input.url;
    }

    if (input.ready !== undefined) {
        part.ready = parseLocator(input.ready);
    }

    return part;
}
