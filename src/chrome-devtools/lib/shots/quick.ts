/**
 * The quick shot: marks on what a tab shows now, no book and no navigation. `tools chrome-devtools shot --mark`
 * and `shot --annotate <plan>` end here, and so can any tool that already holds a CDP session.
 *
 * A web plan is the annotation plan of `tools control draw` with one addition: an item may name a `target` (a page
 * locator) instead of a `rect`. Target items become marks on the page; rect items are drawn in image pixels on top.
 */
import { mkdirSync } from "node:fs";
import { dirname, extname } from "node:path";
import type { CdpLike } from "@genesiscz/utils/chrome-devtools/cdp-like";
import * as kit from "@genesiscz/utils/chrome-devtools/shots/kit";
import { capturePart, DEFAULT_SETUP, type PageSetup } from "@genesiscz/utils/chrome-devtools/shots/page";
import { type ClipInput, type MarkInput, parseShotPart } from "@genesiscz/utils/chrome-devtools/shots/part";
import {
    ANNOTATION_PRESETS,
    type Annotation,
    composeOverlay,
    defineAnnotations,
    encodeImage,
    isPresetName,
    type PlanModules,
    type PresetName,
    readPlanValue,
    renderAnnotationPlan,
    validateAnnotations,
} from "@genesiscz/utils/image";
import { SafeJSON } from "@genesiscz/utils/json";

/** The module a `.ts` plan or book imports the locator helpers from. */
export const SHOTS_MODULE = "@genesis-tools/shots";

/** Types a `.ts` book's default export and returns it unchanged. */
export function defineShots<Book>(book: Book): Book {
    return book;
}

export const SHOTS_MODULES: PlanModules = { [SHOTS_MODULE]: { ...kit, defineShots, defineAnnotations } };

export type ImageFormat = "png" | "webp";

/** How a shot's WebP is written: at most `maxWidth` pixels wide (0 keeps the full width), at `quality` (0 to 100). */
export interface WebpOutput {
    maxWidth: number;
    quality: number;
}

/** The first shot script's setting since 2026-11-10: small enough for a repository, and the labels stay readable. */
export const WEBP_OUTPUT: WebpOutput = { maxWidth: 1200, quality: 60 };

/** The format an output path asks for, by its extension; null for anything but .png and .webp. */
export function imageFormatOf(path: string): ImageFormat | null {
    const extension = extname(path).toLowerCase();
    if (extension === ".png") {
        return "png";
    }

    return extension === ".webp" ? "webp" : null;
}

export interface WebPlan {
    preset?: PresetName;
    clip?: ClipInput;
    marks: MarkInput[];
    /** Items with a `rect`: drawn in image pixels on the final image. */
    pixels: Annotation[];
}

function isMarkInput(value: unknown): value is MarkInput {
    return typeof value === "object" && value !== null && "target" in value && !("rect" in value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pixelItems(items: unknown[]): Annotation[] {
    if (items.length === 0) {
        return [];
    }

    validateAnnotations(items);
    return items;
}

function isLocatorSource(value: unknown): value is string | string[] {
    return typeof value === "string" || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

/** The plan's `clip`, field by field; parseShotPart checks the values. */
function clipInput(value: Record<string, unknown>): ClipInput {
    const pad = value.pad;
    return {
        ...(isLocatorSource(value.around) ? { around: value.around } : {}),
        ...(typeof pad === "number" ? { pad } : {}),
        ...(Array.isArray(pad) && pad.length === 4 && pad.every((side) => typeof side === "number")
            ? { pad: [pad[0], pad[1], pad[2], pad[3]] as const }
            : {}),
        ...(typeof value.wide === "boolean" ? { wide: value.wide } : {}),
        ...(typeof value.viewport === "boolean" ? { viewport: value.viewport } : {}),
        ...(value.fit === "labels" ? { fit: "labels" as const } : {}),
    };
}

/** Inline JSON, or a .json, .jsonc or .ts plan (a `.ts` plan may import the helpers from `@genesis-tools/shots`). */
export async function loadWebPlan(value: string): Promise<WebPlan> {
    const parsed = await readPlanValue(value, { modules: SHOTS_MODULES });
    const plan: Record<string, unknown> = Array.isArray(parsed)
        ? { annotations: parsed }
        : isRecord(parsed)
          ? parsed
          : {};
    if (!Array.isArray(plan.annotations) || plan.annotations.length === 0) {
        throw new Error("a web plan needs a non-empty annotations array (items with a target, or with a rect)");
    }

    if (plan.preset !== undefined && !(typeof plan.preset === "string" && isPresetName(plan.preset))) {
        throw new Error(
            `unknown preset "${String(plan.preset)}" — valid presets: ${Object.keys(ANNOTATION_PRESETS).join(", ")}`
        );
    }

    return {
        ...(typeof plan.preset === "string" && isPresetName(plan.preset) ? { preset: plan.preset } : {}),
        ...(isRecord(plan.clip) ? { clip: clipInput(plan.clip) } : {}),
        marks: plan.annotations.filter(isMarkInput),
        pixels: pixelItems(plan.annotations.filter((item) => !isMarkInput(item))),
    };
}

export interface ShotFiles {
    annotated: string;
    marks: string;
    /** Only when asked for: the raw image, full size, always PNG. */
    raw?: string;
}

/** `shot.webp` → the annotated `shot.webp` and the marks `shot.marks.json`; with `raw`, also `shot.original.png`. */
export function shotFilesFor(out: string, raw = false): ShotFiles {
    const extension = extname(out);
    const stem = out.slice(0, out.length - extension.length);
    return { annotated: out, marks: `${stem}.marks.json`, ...(raw ? { raw: `${stem}.original.png` } : {}) };
}

export type QuickShotResult = { ok: true; files: ShotFiles; notes: string[] } | { ok: false; problems: string[] };

/**
 * Marks what the tab shows now and writes the annotated image and the marks in the raw image's pixels. A WebP is
 * written by `webp` (default WEBP_OUTPUT), a PNG at full size. The raw image is written only with `raw`.
 */
export async function takeQuickShot(input: {
    cdp: CdpLike;
    plan: WebPlan;
    out: string;
    setup?: Partial<PageSetup>;
    raw?: boolean;
    webp?: WebpOutput;
}): Promise<QuickShotResult> {
    const format = imageFormatOf(input.out);
    if (!format) {
        return { ok: false, problems: [`${input.out}: the output must end in .png or .webp`] };
    }

    const preset = input.plan.preset ?? DEFAULT_SETUP.preset;
    // a plan of pixel items only (a control draw plan) marks nothing on the page: it draws on the visible viewport
    const clip = input.plan.clip ?? (input.plan.marks.length === 0 ? { viewport: true, pad: 0 } : undefined);
    const part = parseShotPart({ clip, marks: input.plan.marks });
    const capture = await capturePart(input.cdp, part, { ...DEFAULT_SETUP, settleMs: 0, preset, ...input.setup });
    if (!capture.ok) {
        return capture;
    }

    const composed = await composeOverlay(capture.images);
    const final =
        input.plan.pixels.length > 0
            ? (await renderAnnotationPlan({ input: composed, annotations: input.plan.pixels, preset })).png
            : composed;
    const files = shotFilesFor(input.out, input.raw === true);
    mkdirSync(dirname(input.out), { recursive: true });
    await Bun.write(files.annotated, await encodeImage(final, format, input.webp ?? WEBP_OUTPUT));
    if (files.raw) {
        await Bun.write(files.raw, capture.images.raw);
    }

    await Bun.write(
        files.marks,
        `${SafeJSON.stringify({ preset, annotations: [...capture.images.annotations, ...input.plan.pixels] }, null, 2)}\n`
    );

    return { ok: true, files, notes: capture.notes };
}
