import { SafeJSON } from "@genesiscz/utils/json";
import { type Canvas, createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import {
    ANNOTATION_PRESETS,
    type Annotation,
    type AnnotationPlanFile,
    type AnnotationPreset,
    type AnnotationRect,
    DEFAULT_PRESET,
    GRID_DEFAULTS,
    type GridStyle,
    type LabelChipStyle,
    type LabelPosition,
    type PresetName,
    parseRect,
    type ShapeLabel,
    type ShapeStyle,
} from "./annotation-plan";

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
        if (a === null || typeof a !== "object" || typeof (a as { kind?: unknown }).kind !== "string") {
            throw new Error(`annotations[${i}] must be an object with a "kind" — kinds: ${KNOWN_KINDS.join(", ")}`);
        }

        const kind = (a as { kind: string }).kind;
        if (!KNOWN_KINDS.includes(kind as (typeof KNOWN_KINDS)[number])) {
            throw new Error(`annotations[${i}] has unknown kind "${kind}" — valid kinds: ${KNOWN_KINDS.join(", ")}`);
        }

        const obj = a as Record<string, unknown>;
        if ((kind === "highlight" || kind === "box" || kind === "ellipse" || kind === "blur" || kind === "crop") && !obj.rect) {
            throw new Error(`annotations[${i}] (${kind}) requires "rect"`);
        }

        if (kind === "arrow" && (!obj.from || !obj.to)) {
            throw new Error(`annotations[${i}] (arrow) requires "from" and "to"`);
        }

        if (kind === "label" && (!obj.at || typeof obj.text !== "string")) {
            throw new Error(`annotations[${i}] (label) requires "at" and "text"`);
        }
    }
}

/**
 * `--annotate <value>` sniffing (decision 4): starts with `{`/`[` → inline
 * JSON, else a path to a plan file. A bare array is shorthand for
 * `{ annotations: [...] }`.
 */
export async function loadAnnotationPlanValue(value: string): Promise<AnnotationPlanFile> {
    const trimmed = value.trim();
    let parsed: unknown;

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        parsed = SafeJSON.parse(trimmed);
    } else {
        const file = Bun.file(trimmed);
        if (!(await file.exists())) {
            throw new Error(`annotation plan not found: ${trimmed} (pass inline JSON or a plan.json path)`);
        }

        parsed = SafeJSON.parse(await file.text());
    }

    if (!parsed || typeof parsed !== "object") {
        throw new Error("invalid annotation plan: expected a JSON object or array");
    }

    const plan: AnnotationPlanFile = Array.isArray(parsed)
        ? { annotations: parsed as Annotation[] }
        : (parsed as AnnotationPlanFile);
    validateAnnotations(plan.annotations);

    if (plan.preset !== undefined && !(plan.preset in ANNOTATION_PRESETS)) {
        throw new Error(
            `unknown preset "${plan.preset}" — valid presets: ${Object.keys(ANNOTATION_PRESETS).join(", ")}`
        );
    }

    return plan;
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

interface ChipMetrics {
    x: number;
    y: number;
    w: number;
    h: number;
}

function drawChip(
    ctx: SKRSContext2D,
    text: string,
    style: Required<LabelChipStyle>,
    place: (chipW: number, chipH: number) => { x: number; y: number },
    bounds: { width: number; height: number }
): ChipMetrics {
    ctx.font = `600 ${style.fontSize}px sans-serif`;
    const padX = Math.round(style.fontSize * 0.5);
    const padY = Math.round(style.fontSize * 0.3);
    const textW = ctx.measureText(text).width;
    const w = Math.ceil(textW + padX * 2);
    const h = Math.ceil(style.fontSize + padY * 2);
    const pos = place(w, h);
    const x = Math.max(0, Math.min(pos.x, bounds.width - w));
    const y = Math.max(0, Math.min(pos.y, bounds.height - h));

    ctx.fillStyle = style.bg;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, Math.min(8, h / 2));
    ctx.fill();
    ctx.fillStyle = style.fg;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + padX, y + h / 2 + 1);
    return { x, y, w, h };
}

function placeShapeLabel(
    rect: AnnotationRect,
    position: LabelPosition,
    gap: number
): (chipW: number, chipH: number) => { x: number; y: number } {
    return (chipW, chipH) => {
        const above = rect.y - chipH - gap;
        // fall INSIDE the rect when the chip would leave the image (drawChip
        // clamps the bottom/right overflow against the image bounds)
        const top = above >= 0 ? above : rect.y + gap;
        const bottom = rect.y + rect.h + gap;

        switch (position) {
            case "top-left":
                return { x: rect.x, y: top };
            case "top-right":
                return { x: rect.x + rect.w - chipW, y: top };
            case "bottom-left":
                return { x: rect.x, y: bottom };
            case "bottom-right":
                return { x: rect.x + rect.w - chipW, y: bottom };
            case "top":
                return { x: rect.x + (rect.w - chipW) / 2, y: top };
            case "bottom":
                return { x: rect.x + (rect.w - chipW) / 2, y: bottom };
        }
    };
}

function drawShape(opts: {
    ctx: SKRSContext2D;
    kind: "highlight" | "box" | "ellipse";
    rect: AnnotationRect;
    style: ShapeStyle | undefined;
    label: ShapeLabel | undefined;
    preset: AnnotationPreset;
    bounds: { width: number; height: number };
}): void {
    const { ctx, kind, rect, style, label, preset, bounds } = opts;
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
        ctx.setLineDash(style?.dash ?? []);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    if (label?.text) {
        const chipStyle: Required<LabelChipStyle> = {
            bg: label.style?.bg ?? preset.labelChip.bg,
            fg: label.style?.fg ?? preset.labelChip.fg,
            fontSize: label.style?.fontSize ?? preset.labelChip.fontSize,
        };
        const gap = Math.max(4, Math.round(strokeWidth));
        drawChip(ctx, label.text, chipStyle, placeShapeLabel(rect, label.position ?? "top-left", gap), bounds);
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
    ctx.setLineDash(style?.dash ?? []);
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

    ctx.font = `${style.fontSize}px sans-serif`;
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

    for (const [i, a] of opts.annotations.entries()) {
        switch (a.kind) {
            case "highlight":
            case "box":
            case "ellipse": {
                const rect = parseRect(a.rect);
                if (!(rect.w > 0) || !(rect.h > 0)) {
                    throw new Error(`annotations[${i}] (${a.kind}) has a zero-size rect`);
                }

                drawShape({ ctx, kind: a.kind, rect, style: a.style, label: a.label, preset, bounds });
                break;
            }
            case "arrow":
                drawArrow(ctx, a.from, a.to, a.style, preset);
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
                    () => ({ x: a.at.x, y: a.at.y }),
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
