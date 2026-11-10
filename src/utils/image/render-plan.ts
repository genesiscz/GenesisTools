import { SafeJSON } from "@genesiscz/utils/json";
import { type Canvas, createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import {
    ANNOTATION_PRESETS,
    type Annotation,
    type AnnotationPreset,
    type AnnotationRect,
    DEFAULT_PRESET,
    GRID_DEFAULTS,
    type GridStyle,
    isPresetName,
    LABEL_POSITIONS,
    type LabelChipStyle,
    type PresetName,
    parseRect,
    type ShapeLabel,
    type ShapeStyle,
} from "./annotation-plan";
import { canvasFont } from "./canvas-fonts";
import { clampedSpot, type LabelSize, type PlacedLabel, placeLabel } from "./mark-layout";

const KNOWN_KINDS = ["highlight", "box", "ellipse", "arrow", "label", "blur", "crop", "grid"] as const;

export interface RenderPlanInput {
    /** Image path or PNG/JPEG bytes. */
    input: string | Buffer;
    annotations: Annotation[];
    preset?: PresetName;
}

export interface RenderPlanResult {
    png: Buffer;
    width: number;
    height: number;
    warnings: string[];
}

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

function clampRect(rect: AnnotationRect, width: number, height: number): AnnotationRect {
    const x = Math.max(0, Math.round(rect.x));
    const y = Math.max(0, Math.round(rect.y));
    return {
        x,
        y,
        w: Math.min(Math.round(rect.w) - (x - Math.round(rect.x)), width - x),
        h: Math.min(Math.round(rect.h) - (y - Math.round(rect.y)), height - y),
    };
}

function shapePath(ctx: SKRSContext2D, kind: "highlight" | "box" | "ellipse", r: AnnotationRect, radius: number): void {
    ctx.beginPath();

    if (kind === "ellipse") {
        ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    } else if (radius > 0) {
        ctx.roundRect(r.x, r.y, r.w, r.h, radius);
    } else {
        ctx.rect(r.x, r.y, r.w, r.h);
    }
}

interface ChipLayout {
    size: LabelSize;
    lines: string[];
    padX: number;
    padY: number;
    lineHeight: number;
}

/** A chip's size: the widest line plus padding; each "\n" adds a line. */
function measureChip(ctx: SKRSContext2D, text: string, style: Required<LabelChipStyle>): ChipLayout {
    ctx.font = canvasFont({ sizePx: style.fontSize, weight: 600 });
    const padX = Math.round(style.fontSize * 0.5);
    const padY = Math.round(style.fontSize * 0.3);
    const lineHeight = Math.round(style.fontSize * 1.3);
    const lines = text.split("\n");
    const textW = Math.max(...lines.map((line) => ctx.measureText(line).width));
    const size = {
        w: Math.ceil(textW + padX * 2),
        h: Math.ceil(style.fontSize + padY * 2 + (lines.length - 1) * lineHeight),
    };

    return { size, lines, padX, padY, lineHeight };
}

function paintChip(
    ctx: SKRSContext2D,
    layout: ChipLayout,
    style: Required<LabelChipStyle>,
    at: { x: number; y: number }
): void {
    const { size, lines, padX, padY, lineHeight } = layout;
    ctx.font = canvasFont({ sizePx: style.fontSize, weight: 600 });
    ctx.fillStyle = style.bg;
    ctx.beginPath();
    ctx.roundRect(at.x, at.y, size.w, size.h, Math.min(8, size.h / 2));
    ctx.fill();
    ctx.fillStyle = style.fg;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    for (const [index, line] of lines.entries()) {
        ctx.fillText(line, at.x + padX, at.y + padY + style.fontSize / 2 + 1 + index * lineHeight);
    }
}

/** A free label at a point, pushed back inside the image. */
function drawChip(
    ctx: SKRSContext2D,
    text: string,
    style: Required<LabelChipStyle>,
    at: { x: number; y: number },
    bounds: { width: number; height: number }
): void {
    const layout = measureChip(ctx, text, style);
    paintChip(ctx, layout, style, {
        x: Math.max(0, Math.min(at.x, bounds.width - layout.size.w)),
        y: Math.max(0, Math.min(at.y, bounds.height - layout.size.h)),
    });
}

function chipStyleOf(label: ShapeLabel, preset: AnnotationPreset): Required<LabelChipStyle> {
    return {
        bg: label.style?.bg ?? preset.labelChip.bg,
        fg: label.style?.fg ?? preset.labelChip.fg,
        fontSize: label.style?.fontSize ?? preset.labelChip.fontSize,
    };
}

/**
 * A shape's label: the first spot of mark-layout's order that stays in the image and covers no earlier label
 * (`taken`, which gets this chip). When none fits, the requested spot clamped into the image, with a warning.
 */
function drawShapeLabel(opts: {
    ctx: SKRSContext2D;
    rect: AnnotationRect;
    label: ShapeLabel;
    preset: AnnotationPreset;
    gap: number;
    bounds: { width: number; height: number };
    taken: AnnotationRect[];
    warn: (message: string) => void;
}): void {
    const { ctx, rect, label, preset, gap, bounds, taken } = opts;
    const style = chipStyleOf(label, preset);
    const layout = measureChip(ctx, label.text, style);
    const request = {
        rect,
        size: layout.size,
        position: label.position ?? "top-left",
        gap,
        offset: label.offset,
        leader: label.leader,
    };
    const area = { x: 0, y: 0, w: bounds.width, h: bounds.height };
    const placement = placeLabel({ request, bounds: area, obstacles: taken });
    let placed: PlacedLabel;

    if (placement.ok) {
        placed = placement.label;
    } else {
        placed = clampedSpot(request, area);
        opts.warn(`label "${label.text.split("\n")[0]}" fits nowhere free in the image; drawn at ${request.position}`);
    }

    if (placed.leader) {
        ctx.strokeStyle = style.bg;
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(placed.leader.from.x, placed.leader.from.y);
        ctx.lineTo(placed.leader.to.x, placed.leader.to.y);
        ctx.stroke();
    }

    paintChip(ctx, layout, style, placed.chip);
    taken.push(placed.chip);
}

function drawShape(opts: {
    ctx: SKRSContext2D;
    kind: "highlight" | "box" | "ellipse";
    rect: AnnotationRect;
    style: ShapeStyle | undefined;
    label: ShapeLabel | undefined;
    preset: AnnotationPreset;
    bounds: { width: number; height: number };
    taken: AnnotationRect[];
    warn: (message: string) => void;
}): void {
    const { ctx, kind, rect, style, label, preset } = opts;
    const stroke = style?.stroke ?? preset.shape.stroke;
    const strokeWidth = style?.strokeWidth ?? preset.shape.strokeWidth;
    const fill = style?.fill ?? preset.shape.fill;
    // box means square corners — preset radius applies to highlight only
    const radius = style?.radius ?? (kind === "highlight" ? preset.shape.radius : 0);

    if (fill) {
        shapePath(ctx, kind, rect, radius);
        ctx.fillStyle = fill;
        ctx.fill();
    }

    if (stroke && strokeWidth > 0) {
        shapePath(ctx, kind, rect, radius);
        ctx.strokeStyle = stroke;
        ctx.lineWidth = strokeWidth;
        ctx.setLineDash(style?.dash ?? [...(preset.shape.dash ?? [])]);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    if (label?.text) {
        drawShapeLabel({ ...opts, label, gap: Math.max(4, Math.round(strokeWidth)) });
    }
}

function drawArrow(
    ctx: SKRSContext2D,
    from: { x: number; y: number },
    to: { x: number; y: number },
    style: ShapeStyle | undefined,
    preset: AnnotationPreset
): void {
    const stroke = style?.stroke ?? preset.shape.stroke;
    const strokeWidth = style?.strokeWidth ?? preset.shape.strokeWidth;
    const head = Math.max(10, strokeWidth * 2.5);
    const angle = Math.atan2(to.y - from.y, to.x - from.x);

    ctx.strokeStyle = stroke;
    ctx.lineWidth = strokeWidth;
    ctx.lineCap = "round";
    ctx.setLineDash(style?.dash ?? [...(preset.shape.dash ?? [])]);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    // stop the shaft short of the tip so the head stays crisp
    ctx.lineTo(to.x - Math.cos(angle) * head * 0.6, to.y - Math.sin(angle) * head * 0.6);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = stroke;
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - Math.cos(angle - Math.PI / 6) * head, to.y - Math.sin(angle - Math.PI / 6) * head);
    ctx.lineTo(to.x - Math.cos(angle + Math.PI / 6) * head, to.y - Math.sin(angle + Math.PI / 6) * head);
    ctx.closePath();
    ctx.fill();
}

function drawBlur(ctx: SKRSContext2D, canvas: Canvas, rect: AnnotationRect, strength: number): void {
    // snapshot the CURRENT composite so earlier annotations blur too
    const snapshot = createCanvas(canvas.width, canvas.height);
    snapshot.getContext("2d").drawImage(canvas, 0, 0);

    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    ctx.filter = `blur(${strength}px)`;
    ctx.drawImage(snapshot, 0, 0);
    ctx.restore();
    ctx.filter = "none";
}

function drawGrid(
    ctx: SKRSContext2D,
    bounds: { width: number; height: number },
    annotation: Extract<Annotation, { kind: "grid" }>
): void {
    const style: Required<GridStyle> = { ...GRID_DEFAULTS, ...annotation.style };
    const step = Math.max(4, annotation.step !== undefined && annotation.step > 0 ? annotation.step : 100);
    const ox = annotation.originOffset?.x ?? 0;
    const oy = annotation.originOffset?.y ?? 0;
    const withLabels = annotation.labels !== false;
    // odd line widths straddle pixel boundaries — offset half a pixel for crisp lines
    const snap = style.lineWidth % 2 === 1 ? 0.5 : 0;

    const xs: { px: number; abs: number }[] = [];
    for (let gx = Math.ceil(ox / step) * step; gx < ox + bounds.width; gx += step) {
        xs.push({ px: Math.round(gx - ox), abs: gx });
    }

    const ys: { px: number; abs: number }[] = [];
    for (let gy = Math.ceil(oy / step) * step; gy < oy + bounds.height; gy += step) {
        ys.push({ px: Math.round(gy - oy), abs: gy });
    }

    ctx.strokeStyle = style.line;
    ctx.lineWidth = style.lineWidth;
    ctx.beginPath();
    for (const { px } of xs) {
        ctx.moveTo(px + snap, 0);
        ctx.lineTo(px + snap, bounds.height);
    }

    for (const { px } of ys) {
        ctx.moveTo(0, px + snap);
        ctx.lineTo(bounds.width, px + snap);
    }

    ctx.stroke();

    if (!withLabels) {
        return;
    }

    ctx.font = canvasFont({ sizePx: style.fontSize });
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const drawGridLabel = (text: string, x: number, y: number): void => {
        const w = Math.ceil(ctx.measureText(text).width);
        ctx.fillStyle = style.labelBg;
        ctx.fillRect(x, y, w + 4, style.fontSize + 4);
        ctx.fillStyle = style.labelFg;
        ctx.fillText(text, x + 2, y + 2);
    };

    for (const { px, abs } of xs) {
        drawGridLabel(String(abs), px + 3, 3);
    }

    for (const { px, abs } of ys) {
        drawGridLabel(String(abs), 3, px + 2);
    }
}

/**
 * Render an annotation plan onto an image. Deterministic: same input + plan →
 * byte-identical PNG. Draws in array order; `crop` entries apply LAST.
 */
export async function renderAnnotationPlan(opts: RenderPlanInput): Promise<RenderPlanResult> {
    validateAnnotations(opts.annotations);
    const preset = ANNOTATION_PRESETS[opts.preset ?? DEFAULT_PRESET];
    if (!preset) {
        throw new Error(
            `unknown preset "${opts.preset}" — valid presets: ${Object.keys(ANNOTATION_PRESETS).join(", ")}`
        );
    }

    const warnings: string[] = [];
    const image = await loadImage(opts.input);
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const bounds = { width: image.width, height: image.height };
    const taken: AnnotationRect[] = [];
    const warn = (message: string): void => {
        warnings.push(message);
    };
    const presetOf = (name: PresetName | undefined): AnnotationPreset => (name ? ANNOTATION_PRESETS[name] : preset);

    for (const [i, a] of opts.annotations.entries()) {
        switch (a.kind) {
            case "highlight":
            case "box":
            case "ellipse": {
                const rect = parseRect(a.rect);
                if (!(rect.w > 0) || !(rect.h > 0)) {
                    throw new Error(`annotations[${i}] (${a.kind}) has a zero-size rect`);
                }

                drawShape({
                    ctx,
                    kind: a.kind,
                    rect,
                    style: a.style,
                    label: a.label,
                    preset: presetOf(a.preset),
                    bounds,
                    taken,
                    warn,
                });
                break;
            }
            case "arrow":
                drawArrow(ctx, a.from, a.to, a.style, presetOf(a.preset));
                break;
            case "label":
                drawChip(
                    ctx,
                    a.text,
                    {
                        bg: a.style?.bg ?? preset.labelChip.bg,
                        fg: a.style?.fg ?? preset.labelChip.fg,
                        fontSize: a.style?.fontSize ?? preset.labelChip.fontSize,
                    },
                    a.at,
                    bounds
                );
                break;
            case "blur": {
                const rect = clampRect(parseRect(a.rect), bounds.width, bounds.height);
                if (!(rect.w > 0) || !(rect.h > 0)) {
                    warnings.push(`annotations[${i}] (blur) lies outside the image — skipped`);
                    break;
                }

                drawBlur(ctx, canvas, rect, a.strength ?? preset.blurStrength);
                break;
            }
            case "grid":
                drawGrid(ctx, bounds, a);
                break;
            case "crop":
                break;
        }
    }

    const crops = opts.annotations.filter((a): a is Extract<Annotation, { kind: "crop" }> => a.kind === "crop");
    if (crops.length > 1) {
        warnings.push(`${crops.length} crop annotations — only the last applies`);
    }

    let output = canvas;
    if (crops.length > 0) {
        const requested = parseRect(crops[crops.length - 1].rect);
        const rect = clampRect(requested, bounds.width, bounds.height);
        if (!(rect.w > 0) || !(rect.h > 0)) {
            throw new Error(
                `crop rect ${SafeJSON.stringify(requested)} lies outside the ${bounds.width}x${bounds.height} image`
            );
        }

        if (rect.w !== requested.w || rect.h !== requested.h || rect.x !== requested.x || rect.y !== requested.y) {
            warnings.push(`crop rect clamped to ${SafeJSON.stringify(rect)}`);
        }

        const cropped = createCanvas(rect.w, rect.h);
        cropped.getContext("2d").drawImage(canvas, -rect.x, -rect.y);
        output = cropped;
    }

    return {
        png: output.toBuffer("image/png"),
        width: output.width,
        height: output.height,
        warnings,
    };
}
