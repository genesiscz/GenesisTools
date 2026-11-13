/**
 * Annotation plan contract — the JSON shape `tools control draw`, the
 * `annotate_image` MCP tool, and the capture flow all share.
 *
 * Coordinates are NATURAL IMAGE PIXELS (the same space vitrinka annotation
 * regions use — getBoundingClientRect-measured, never eyeballed). Annotations
 * draw in array order; a `crop` entry is applied LAST regardless of position.
 */

export interface AnnotationPoint {
    x: number;
    y: number;
}

export interface AnnotationRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Object form preferred; "x,y,w,h" strings accepted (capture Region idiom). */
export type RectInput = AnnotationRect | string;

export interface ShapeStyle {
    stroke?: string;
    strokeWidth?: number;
    /** Corner radius — highlight defaults to the preset's, box defaults to 0. */
    radius?: number;
    /** Translucent wash inside the shape (or solid blackout for redact). */
    fill?: string;
    /** Canvas line-dash segments, e.g. [12, 8]; omit for solid. */
    dash?: number[];
}

export interface LabelChipStyle {
    bg?: string;
    fg?: string;
    fontSize?: number;
}

/**
 * Where a shape's label sits: outside above (`top-*`, `top`) or below (`bottom-*`, `bottom`), beside it (`left`,
 * `right`, vertically centered, with a leader line by default) or in its top-left corner (`inside`). When the spot
 * leaves the image or covers an earlier label, the renderer tries the other positions (mark-layout.ts).
 */
export const LABEL_POSITIONS = [
    "top-left",
    "top-right",
    "bottom-left",
    "bottom-right",
    "top",
    "bottom",
    "left",
    "right",
    "inside",
] as const;

export type LabelPosition = (typeof LABEL_POSITIONS)[number];

export interface ShapeLabel {
    /** A "\n" starts a new line in the chip. */
    text: string;
    position?: LabelPosition;
    style?: LabelChipStyle;
    /** Moves the label from the spot its position gives, in image pixels (a hand nudge). */
    offset?: AnnotationPoint;
    /** A line from a `left` or `right` label to its shape. Default true for those two, ignored for the others. */
    leader?: boolean;
}

export interface GridStyle {
    line?: string;
    lineWidth?: number;
    labelFg?: string;
    labelBg?: string;
    fontSize?: number;
}

export type Annotation =
    | { kind: "highlight"; rect: RectInput; style?: ShapeStyle; label?: ShapeLabel; preset?: PresetName }
    | { kind: "box"; rect: RectInput; style?: ShapeStyle; label?: ShapeLabel; preset?: PresetName }
    | { kind: "ellipse"; rect: RectInput; style?: ShapeStyle; label?: ShapeLabel; preset?: PresetName }
    | { kind: "arrow"; from: AnnotationPoint; to: AnnotationPoint; style?: ShapeStyle; preset?: PresetName }
    | { kind: "label"; at: AnnotationPoint; text: string; style?: LabelChipStyle }
    | { kind: "blur"; rect: RectInput; strength?: number }
    | { kind: "crop"; rect: RectInput }
    | {
          kind: "grid";
          /** Grid step in origin-space units (default 100). */
          step?: number;
          /**
           * Coordinate of the image's top-left corner in the space the labels
           * should report (e.g. global screen points for clickmap). Gridlines
           * land on absolute multiples of `step` in that space. Default 0,0.
           */
          originOffset?: AnnotationPoint;
          /** Draw absolute-coordinate labels at gridlines (default true). */
          labels?: boolean;
          style?: GridStyle;
      };

export interface AnnotationPlanFile {
    /** Source image path — optional when the caller supplies bytes (capture flow). */
    input?: string;
    /** Output path — CLI defaults to <input>-annotated.png. */
    output?: string;
    annotations: Annotation[];
    preset?: PresetName;
}

export interface AnnotationPreset {
    shape: Required<Pick<ShapeStyle, "stroke" | "strokeWidth" | "radius" | "fill">> & { dash?: readonly number[] };
    labelChip: Required<LabelChipStyle>;
    blurStrength: number;
}

/**
 * Hardcoded preset style bags (decision 5: one object per preset). A plan picks one for all its shapes, and a shape
 * may pick its own with `preset`, so red and amber marks mix in one plan.
 * review-red is Martin's hand-annotation register: thick red rounded outline
 * with a translucent wash (vitrinka annotation 27 is the visual reference).
 */
export const ANNOTATION_PRESETS = {
    "review-red": {
        shape: { stroke: "#ff5a5f", strokeWidth: 6, radius: 18, fill: "rgba(255,90,95,0.08)" },
        labelChip: { bg: "#ff5a5f", fg: "#ffffff", fontSize: 24 },
        blurStrength: 12,
    },
    "callout-amber": {
        shape: { stroke: "#ffb020", strokeWidth: 4, radius: 12, fill: "rgba(255,176,32,0.10)" },
        labelChip: { bg: "#ffb020", fg: "#111111", fontSize: 24 },
        blurStrength: 12,
    },
    redact: {
        shape: { stroke: "#111111", strokeWidth: 2, radius: 4, fill: "#111111" },
        labelChip: { bg: "#111111", fg: "#ffffff", fontSize: 24 },
        blurStrength: 24,
    },
    /** The look of the annotated web shots (a 3 px dashed outline, no wash, a small chip): page-sized, not 4K. */
    "review-dashed": {
        shape: { stroke: "#ff4d4f", strokeWidth: 3, radius: 8, fill: "", dash: [9, 6] },
        labelChip: { bg: "#ff4d4f", fg: "#ffffff", fontSize: 14 },
        blurStrength: 12,
    },
    /** The amber twin of review-dashed. Dark text on amber, as callout-amber: white on #ffb020 is 1.8:1. */
    "callout-amber-dashed": {
        shape: { stroke: "#ffb020", strokeWidth: 3, radius: 8, fill: "", dash: [9, 6] },
        labelChip: { bg: "#ffb020", fg: "#111111", fontSize: 14 },
        blurStrength: 12,
    },
    "info-blue": {
        shape: { stroke: "#2f80ed", strokeWidth: 4, radius: 12, fill: "rgba(47,128,237,0.08)" },
        labelChip: { bg: "#2f80ed", fg: "#ffffff", fontSize: 24 },
        blurStrength: 12,
    },
    "ok-green": {
        shape: { stroke: "#1f9d55", strokeWidth: 4, radius: 12, fill: "rgba(31,157,85,0.08)" },
        labelChip: { bg: "#1f9d55", fg: "#ffffff", fontSize: 24 },
        blurStrength: 12,
    },
    "question-purple": {
        shape: { stroke: "#8b5cf6", strokeWidth: 4, radius: 12, fill: "rgba(139,92,246,0.08)" },
        labelChip: { bg: "#8b5cf6", fg: "#ffffff", fontSize: 24 },
        blurStrength: 12,
    },
    /** Context, not a finding: a thin gray outline that recedes beside a red or amber mark. */
    "muted-gray": {
        shape: { stroke: "#8a8f98", strokeWidth: 2, radius: 8, fill: "", dash: [6, 4] },
        labelChip: { bg: "#5f6368", fg: "#ffffff", fontSize: 20 },
        blurStrength: 12,
    },
} as const satisfies Record<string, AnnotationPreset>;

export type PresetName = keyof typeof ANNOTATION_PRESETS;

export const DEFAULT_PRESET: PresetName = "review-red";

export const GRID_DEFAULTS: Required<GridStyle> = {
    line: "#ff00ff90",
    lineWidth: 1,
    labelFg: "#ffff00",
    labelBg: "#000000b0",
    fontSize: 12,
};

/** An own preset name only: `toString`, `constructor` and `__proto__` are inherited, not presets. */
export function isPresetName(value: string): value is PresetName {
    return Object.hasOwn(ANNOTATION_PRESETS, value);
}

export function parseRect(rect: RectInput): AnnotationRect {
    if (typeof rect === "string") {
        const parts = rect.split(",").map((n) => Number(n.trim()));
        if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
            throw new Error(`malformed rect "${rect}" — expected "x,y,w,h" with 4 finite numbers`);
        }

        const [x, y, w, h] = parts;
        return { x, y, w, h };
    }

    return rect;
}

const KNOWN_KINDS = ["highlight", "box", "ellipse", "arrow", "label", "blur", "crop", "grid"] as const;

export function validateAnnotations(annotations: unknown): asserts annotations is Annotation[] {
    if (!Array.isArray(annotations) || annotations.length === 0) {
        throw new Error(`annotations must be a non-empty array — kinds: ${KNOWN_KINDS.join(", ")}`);
    }

    for (const [i, a] of annotations.entries()) {
        if (a !== null && typeof a === "object" && "target" in a && !("rect" in a)) {
            throw new Error(
                `annotations[${i}] names a target (a page locator), which only a live page resolves: draw it with the page-shot command of chrome-devtools (shot --annotate)`
            );
        }

        if (a === null || typeof a !== "object" || typeof (a as { kind?: unknown }).kind !== "string") {
            throw new Error(`annotations[${i}] must be an object with a "kind" — kinds: ${KNOWN_KINDS.join(", ")}`);
        }

        const kind = (a as { kind: string }).kind;
        if (!KNOWN_KINDS.includes(kind as (typeof KNOWN_KINDS)[number])) {
            throw new Error(`annotations[${i}] has unknown kind "${kind}" — valid kinds: ${KNOWN_KINDS.join(", ")}`);
        }

        const obj = a as Record<string, unknown>;
        if (
            (kind === "highlight" || kind === "box" || kind === "ellipse" || kind === "blur" || kind === "crop") &&
            !obj.rect
        ) {
            throw new Error(`annotations[${i}] (${kind}) requires "rect"`);
        }

        if (kind === "arrow" && (!obj.from || !obj.to)) {
            throw new Error(`annotations[${i}] (arrow) requires "from" and "to"`);
        }

        if (kind === "label" && (!obj.at || typeof obj.text !== "string")) {
            throw new Error(`annotations[${i}] (label) requires "at" and "text"`);
        }

        if (obj.preset !== undefined && !(typeof obj.preset === "string" && isPresetName(obj.preset))) {
            throw new Error(
                `annotations[${i}] has unknown preset "${String(obj.preset)}" — valid presets: ${Object.keys(ANNOTATION_PRESETS).join(", ")}`
            );
        }

        const position = (obj.label as { position?: unknown } | undefined)?.position;
        if (position !== undefined && !LABEL_POSITIONS.some((known) => known === position)) {
            throw new Error(
                `annotations[${i}] has unknown label position "${String(position)}" — valid positions: ${LABEL_POSITIONS.join(", ")}`
            );
        }
    }
}
