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

export type LabelPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right" | "top" | "bottom";

export interface ShapeLabel {
    text: string;
    position?: LabelPosition;
    style?: LabelChipStyle;
}

export interface GridStyle {
    line?: string;
    lineWidth?: number;
    labelFg?: string;
    labelBg?: string;
    fontSize?: number;
}

export type Annotation =
    | { kind: "highlight"; rect: RectInput; style?: ShapeStyle; label?: ShapeLabel }
    | { kind: "box"; rect: RectInput; style?: ShapeStyle; label?: ShapeLabel }
    | { kind: "ellipse"; rect: RectInput; style?: ShapeStyle; label?: ShapeLabel }
    | { kind: "arrow"; from: AnnotationPoint; to: AnnotationPoint; style?: ShapeStyle }
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
    shape: Required<Pick<ShapeStyle, "stroke" | "strokeWidth" | "radius" | "fill">>;
    labelChip: Required<LabelChipStyle>;
    blurStrength: number;
}

/**
 * Hardcoded preset style bags (decision 5 — YAGNI, add a 4th as one object).
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

export function isPresetName(value: string): value is PresetName {
    return value in ANNOTATION_PRESETS;
}

export function parseRect(rect: RectInput): AnnotationRect {
    if (typeof rect === "string") {
        const [x, y, w, h] = rect.split(",").map((n) => Number(n.trim()));
        return { x, y, w, h };
    }

    return rect;
}
