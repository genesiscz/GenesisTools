/**
 * One part of an annotated page shot: where to go, what to wait for and click, what to crop, and what to mark.
 * A mark is an annotation of `image/annotation-plan.ts` whose rectangle is a locator; the words of the first shot
 * script (`at: "below"`, `dx`, `dy`, `color`, `quiet`, a string label) are accepted and turned into that model here,
 * at the boundary, so nothing after it knows them.
 */
import {
    isPresetName,
    LABEL_POSITIONS,
    type LabelChipStyle,
    type LabelPosition,
    type PresetName,
    type ShapeLabel,
    type ShapeStyle,
} from "@genesiscz/utils/image/annotation-plan";
import { type Locator, type LocatorSource, parseLocator } from "./locator.ts";

/** The first script's label sides. */
export type ScriptSide = "above" | "below" | "left" | "right" | "inside";
export type ScriptColor = "red" | "amber";
export const MARK_KINDS = ["highlight", "box", "ellipse"] as const;
export type MarkKind = (typeof MARK_KINDS)[number];

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
    /** Absent only for a part with no marks and `viewport`: the clip is then the whole viewport. */
    around?: Locator;
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

/** A side in the script's words or a label position name. */
export function isMarkSide(value: string): value is ScriptSide | LabelPosition {
    return isScriptSide(value) || LABEL_POSITIONS.some((known) => known === value);
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

function kindOf(kind: unknown, path: string): MarkKind {
    if (kind === undefined) {
        return "highlight";
    }

    const known = MARK_KINDS.find((candidate) => candidate === kind);
    if (!known) {
        throw new ShotPartError(`${path}.kind: expected ${MARK_KINDS.join(", ")}, got ${String(kind)}`);
    }

    return known;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function chipStyleOf(style: unknown, path: string): LabelChipStyle {
    if (
        !isRecord(style) ||
        (style.bg !== undefined && typeof style.bg !== "string") ||
        (style.fg !== undefined && typeof style.fg !== "string") ||
        (style.fontSize !== undefined && !(typeof style.fontSize === "number" && style.fontSize > 0))
    ) {
        throw new ShotPartError(`${path}: expected { bg?: color, fg?: color, fontSize?: pixels }`);
    }

    return {
        ...(typeof style.bg === "string" ? { bg: style.bg } : {}),
        ...(typeof style.fg === "string" ? { fg: style.fg } : {}),
        ...(typeof style.fontSize === "number" ? { fontSize: style.fontSize } : {}),
    };
}

/** A book is JSON or a `.ts` file, so a label is checked field by field here, never trusted to be a ShapeLabel. */
function labelOf(label: unknown, path: string): ShapeLabel | undefined {
    if (label === undefined) {
        return undefined;
    }

    if (typeof label === "string") {
        return { text: label };
    }

    if (!isRecord(label) || typeof label.text !== "string") {
        throw new ShotPartError(`${path}.label: expected a string or { text, position?, style?, offset?, leader? }`);
    }

    const parsed: ShapeLabel = { text: label.text };
    if (label.position !== undefined) {
        const position = LABEL_POSITIONS.find((known) => known === label.position);
        if (!position) {
            throw new ShotPartError(
                `${path}.label.position: expected ${LABEL_POSITIONS.join(", ")}, got ${String(label.position)}`
            );
        }

        parsed.position = position;
    }

    if (label.style !== undefined) {
        parsed.style = chipStyleOf(label.style, `${path}.label.style`);
    }

    const offset = label.offset;
    if (offset !== undefined) {
        if (!isRecord(offset) || !Number.isFinite(offset.x) || !Number.isFinite(offset.y)) {
            throw new ShotPartError(`${path}.label.offset: expected { x, y } in pixels`);
        }

        parsed.offset = { x: Number(offset.x), y: Number(offset.y) };
    }

    if (label.leader !== undefined) {
        if (typeof label.leader !== "boolean") {
            throw new ShotPartError(`${path}.label.leader: expected true or false`);
        }

        parsed.leader = label.leader;
    }

    return parsed;
}

function parseMark(input: MarkInput, defaults: PartDefaults, path: string): Mark {
    const label = labelOf(input.label, path);
    const position = sideOf(input.at, path) ?? label?.position;
    const nudged = input.dx !== undefined || input.dy !== undefined;
    const preset = input.preset ?? (input.color === "amber" ? defaults.amberPreset : undefined);
    if (preset !== undefined && !isPresetName(preset)) {
        throw new ShotPartError(`${path}.preset: unknown preset "${preset}"`);
    }

    const mark: Mark = { kind: kindOf(input.kind, path), target: parseLocator(input.target) };
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
    const viewport = input.clip?.viewport ?? input.viewportOnly ?? false;
    if (around === undefined && marks.length === 0 && !viewport) {
        throw new ShotPartError(
            `${path}.clip.around: a part with no marks needs a clip (an around, or viewport: true)`
        );
    }

    const clip: Clip = {
        pad: padOf(input.clip?.pad, defaults.pad, `${path}.clip`),
        wide: input.clip?.wide ?? false,
        viewport,
        fitLabels: input.clip?.fit === "labels",
    };
    if (around !== undefined) {
        clip.around = parseLocator(around);
    } else if (marks.length > 0) {
        clip.around = parseLocator(marks.flatMap((mark) => mark.target.chains.map((chain) => chain.source)));
    }
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
