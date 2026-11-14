/**
 * The page side of annotated shots over any CDP session (`CdpLike`): GenesisTools' own `Conn` through `cdpLikeOf`,
 * or a Playwright `CDPSession` in a project that vendors this folder. Buffers out, no files.
 */
import { Buffer } from "node:buffer";
import { setTimeout as sleep } from "node:timers/promises";
import {
    ANNOTATION_PRESETS,
    type Annotation,
    type AnnotationPreset,
    type AnnotationRect,
    type PresetName,
    type ShapeLabel,
} from "@genesiscz/utils/image/annotation-plan";
import { checkImageDimensions } from "@genesiscz/utils/image/dimensions";
import {
    type LabelRequest,
    labelSpot,
    type PlacedLabel,
    placeLabel,
    rectsOverlap,
} from "@genesiscz/utils/image/mark-layout";
import type { CdpLike } from "../cdp-like.ts";
import { callInPage, evaluateExpression } from "../evaluate.ts";
import {
    clearShotOverlay,
    collectTextRects,
    type DocBox,
    freezeShotPage,
    measureShotChips,
    paintShotOverlay,
    readShotPageMetrics,
    resolveShotLocators,
    type ShotChipPaint,
    type ShotChipStyle,
    type ShotFramePaint,
    type ShotLeaderPaint,
    type ShotPageMetrics,
    type WireResolution,
} from "../in-page/shot-agent.ts";
import type { Locator } from "./locator.ts";
import type { Mark, ShotPart } from "./part.ts";

export type { DocBox } from "../in-page/shot-agent.ts";
export type Resolution = WireResolution;

/** The overlay root's id; the text collector skips it. */
export const SHOT_OVERLAY_ID = "genesis-shot-overlay";
const FREEZE_STYLE_ID = "genesis-shot-freeze";
/** The attribute `testid=` reads. */
export const TEST_ID_ATTRIBUTE = "data-testid";
const TEXT_RECT_LIMIT = 5000;
/** A frame stands this far off its element, as the first shot script drew it. */
const FRAME_PAD = 4;
const LABEL_GAP = 4;
const POLL_MS = 250;

/** All locators of a part in one round trip, in order. */
export async function resolveLocators(cdp: CdpLike, locators: readonly Locator[]): Promise<Resolution[]> {
    return callInPage(cdp, resolveShotLocators, { locators: [...locators], testIdAttribute: TEST_ID_ATTRIBUTE });
}

/** The page's text line boxes that touch `clip`: what a label must not cover. */
export async function textRects(cdp: CdpLike, clip: DocBox): Promise<DocBox[]> {
    return callInPage(cdp, collectTextRects, { clip, limit: TEXT_RECT_LIMIT, overlayId: SHOT_OVERLAY_ID });
}

/** A miss in words: `testid=x matched nothing`, with the union member that missed. */
export function describeMiss(resolution: Extract<Resolution, { ok: false }>): string {
    const what = resolution.member ? `${resolution.source} (member ${resolution.member})` : resolution.source;
    return resolution.reason === "none" ? `${what} matched nothing` : `${what} matched only hidden or empty elements`;
}

/** How every part of a run prepares the page. */
export interface PageSetup {
    /** Joined with a part's `url`. */
    base?: string;
    /** Applied with Emulation.setDeviceMetricsOverride; leave it out to keep the tab's own size. */
    viewport?: { width: number; height: number; scale: number };
    /** Banners to click away when present (a cookie dialog). */
    dismiss: Locator[];
    settleMs: number;
    freeze: boolean;
    readyTimeoutMs: number;
    /** The look of a mark that names no preset. */
    preset: PresetName;
}

export const DEFAULT_SETUP: PageSetup = {
    dismiss: [],
    settleMs: 1500,
    freeze: true,
    readyTimeoutMs: 90_000,
    preset: "review-dashed",
};

export interface PartImages {
    /** PNG, the page as it is. */
    raw: Buffer;
    /** PNG, the same clip with the overlay; compose it with `painted` (image/stack.ts) for the final image. */
    annotated: Buffer;
    /**
     * Image-pixel areas the overlay drew on; outside them the composed image takes the raw pixels. That holds for the
     * composed PNG (and a .png output, written as it is); a WebP output is lossy and re-encodes every pixel.
     */
    painted: AnnotationRect[];
    /** The marks in image pixels with the label positions used: an annotate_image / control draw plan. */
    annotations: Annotation[];
    /** The clip in document pixels, and image pixels per CSS pixel. */
    clip: DocBox;
    scale: number;
    width: number;
    height: number;
    /** The font family the labels were drawn in (the page's body font). */
    font: string;
}

export type PartCapture = { ok: true; images: PartImages; notes: string[] } | { ok: false; problems: string[] };

async function untilResolved(cdp: CdpLike, locator: Locator, timeoutMs: number): Promise<Resolution> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const [resolution] = await resolveLocators(cdp, [locator]);
        if (resolution.ok || Date.now() >= deadline) {
            return resolution;
        }

        await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
    }
}

async function act(cdp: CdpLike, locator: Locator, action: "click" | "scroll"): Promise<Resolution> {
    const [resolution] = await callInPage(cdp, resolveShotLocators, {
        locators: [locator],
        testIdAttribute: TEST_ID_ATTRIBUTE,
        act: action,
    });

    return resolution;
}

/** True once the document is past "loading"; false when `timeoutMs` ran out first. */
async function untilLoaded(cdp: CdpLike, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if ((await evaluateExpression(cdp, "document.readyState").catch(() => "loading")) !== "loading") {
            return true;
        }

        if (Date.now() >= deadline) {
            return false;
        }

        await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
    }
}

function grow(box: DocBox, by: number): DocBox {
    return { x: box.x - by, y: box.y - by, w: box.w + 2 * by, h: box.h + 2 * by };
}

function unionOf(boxes: readonly DocBox[]): DocBox {
    const left = Math.min(...boxes.map((box) => box.x));
    const top = Math.min(...boxes.map((box) => box.y));
    const right = Math.max(...boxes.map((box) => box.x + box.w));
    const bottom = Math.max(...boxes.map((box) => box.y + box.h));
    return { x: left, y: top, w: right - left, h: bottom - top };
}

function intersect(a: DocBox, b: DocBox): DocBox {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    return { x, y, w: Math.min(a.x + a.w, b.x + b.w) - x, h: Math.min(a.y + a.h, b.y + b.h) - y };
}

/** Whole CSS pixels, so the screenshot and the overlay agree to the pixel. */
function snap(box: DocBox): DocBox {
    const x = Math.floor(box.x);
    const y = Math.floor(box.y);
    return { x, y, w: Math.ceil(box.x + box.w) - x, h: Math.ceil(box.y + box.h) - y };
}

/** The part's crop; with no `around` (a part with no marks and `clip.viewport`), the whole viewport. */
function clipOf(part: ShotPart, around: DocBox | undefined, metrics: ShotPageMetrics): DocBox {
    const [top, right, bottom, left] = part.clip.pad;
    const page = part.clip.viewport
        ? { x: metrics.scrollX, y: metrics.scrollY, w: metrics.viewport.w, h: metrics.viewport.h }
        : { x: 0, y: 0, w: metrics.document.w, h: metrics.document.h };
    if (!around) {
        return snap(page);
    }

    const padded = { x: around.x - left, y: around.y - top, w: around.w + left + right, h: around.h + top + bottom };
    const wide = part.clip.wide ? { ...padded, x: page.x, w: page.w } : padded;

    return snap(intersect(wide, page));
}

function presetOf(mark: Mark, setup: PageSetup): AnnotationPreset {
    return ANNOTATION_PRESETS[mark.preset ?? setup.preset];
}

function chipStyleOf(mark: Mark, preset: AnnotationPreset): ShotChipStyle {
    return {
        bg: mark.label?.style?.bg ?? preset.labelChip.bg,
        fg: mark.label?.style?.fg ?? preset.labelChip.fg,
        fontSize: mark.label?.style?.fontSize ?? preset.labelChip.fontSize,
    };
}

function frameOf(mark: Mark, box: DocBox, preset: AnnotationPreset): ShotFramePaint {
    return {
        shape: mark.kind === "ellipse" ? "ellipse" : "rect",
        box,
        stroke: mark.style?.stroke ?? preset.shape.stroke,
        strokeWidth: mark.style?.strokeWidth ?? preset.shape.strokeWidth,
        dash: [...(mark.style?.dash ?? preset.shape.dash ?? [])],
        radius: mark.style?.radius ?? (mark.kind === "box" ? 0 : preset.shape.radius),
        fill: mark.style?.fill ?? preset.shape.fill,
    };
}

/** Half the width of an ellipse with radii `rx`, `ry` at `dy` from its centre; 0 at or past its top and bottom. */
function ellipseHalfWidth(rx: number, ry: number, dy: number): number {
    if (rx <= 0 || ry <= 0 || Math.abs(dy) >= ry) {
        return 0;
    }

    return rx * Math.sqrt(1 - (dy / ry) ** 2);
}

/**
 * An unfilled ellipse's stroke as horizontal strips about one stroke band high, so a strip's slack follows the stroke
 * and not the ellipse's size: in each strip, the span between the inner and the outer edge of the stroke on the left
 * and on the right (the whole outer span where the strip passes above the inner edge).
 */
function ellipseStrokeArea(frame: ShotFramePaint): DocBox[] {
    // The stroke lies inside the box; the outer edge also takes half a stroke of slack, as a centred stroke would.
    const cx = frame.box.x + frame.box.w / 2;
    const cy = frame.box.y + frame.box.h / 2;
    const slack = frame.strokeWidth / 2 + 1;
    const outer = { rx: frame.box.w / 2 + slack, ry: frame.box.h / 2 + slack };
    const inner = { rx: frame.box.w / 2 - frame.strokeWidth - 1, ry: frame.box.h / 2 - frame.strokeWidth - 1 };
    const areas: DocBox[] = [];
    const strips = Math.max(1, Math.ceil((2 * outer.ry) / (frame.strokeWidth + 2)));
    const height = (2 * outer.ry) / strips;

    for (let strip = 0; strip < strips; strip++) {
        const top = cy - outer.ry + strip * height;
        const bottom = top + height;
        // The outer edge is widest at the row nearest the centre, the inner edge narrowest at the row farthest away.
        const nearest = top <= cy && bottom >= cy ? 0 : Math.min(Math.abs(top - cy), Math.abs(bottom - cy));
        const farthest = Math.max(Math.abs(top - cy), Math.abs(bottom - cy));
        const out = Math.ceil(ellipseHalfWidth(outer.rx, outer.ry, nearest)) + 1;
        const within = Math.floor(ellipseHalfWidth(inner.rx, inner.ry, farthest)) - 1;
        const y = Math.floor(top);
        const h = Math.ceil(bottom) - y;

        if (within <= 0) {
            areas.push({ x: Math.floor(cx - out), y, w: 2 * out + 1, h });
            continue;
        }

        areas.push({ x: Math.floor(cx - out), y, w: Math.ceil(out - within) + 1, h });
        areas.push({ x: Math.floor(cx + within), y, w: Math.ceil(out - within) + 1, h });
    }

    return areas;
}

/**
 * The areas a frame draws on: its four stroke bands plus its corners (a rounded corner's stroke curves in past the
 * straight bands), an ellipse's curved stroke, or the whole box when it is filled.
 */
export function shotFrameArea(frame: ShotFramePaint): DocBox[] {
    if (frame.fill) {
        return [grow(frame.box, 1)];
    }

    if (frame.strokeWidth <= 0) {
        return [];
    }

    if (frame.shape === "ellipse") {
        return ellipseStrokeArea(frame);
    }

    const band = frame.strokeWidth + 2;
    const corner = Math.min(Math.ceil(frame.radius + frame.strokeWidth) + 2, frame.box.w / 2, frame.box.h / 2);
    const { x, y, w, h } = grow(frame.box, 1);
    return [
        { x, y, w, h: band },
        { x, y: y + h - band, w, h: band },
        { x, y, w: band, h },
        { x: x + w - band, y, w: band, h },
        { x, y, w: corner, h: corner },
        { x: x + w - corner, y, w: corner, h: corner },
        { x, y: y + h - corner, w: corner, h: corner },
        { x: x + w - corner, y: y + h - corner, w: corner, h: corner },
    ];
}

function leaderArea(leader: ShotLeaderPaint): DocBox {
    return grow(
        unionOf([
            { ...leader.from, w: 0, h: 0 },
            { ...leader.to, w: 0, h: 0 },
        ]),
        2
    );
}

function toImage(box: DocBox, clip: DocBox, scale: number): AnnotationRect {
    const x = Math.max(0, Math.floor((box.x - clip.x) * scale));
    const y = Math.max(0, Math.floor((box.y - clip.y) * scale));
    return {
        x,
        y,
        w: Math.min(Math.ceil((box.x + box.w - clip.x) * scale), Math.round(clip.w * scale)) - x,
        h: Math.min(Math.ceil((box.y + box.h - clip.y) * scale), Math.round(clip.h * scale)) - y,
    };
}

async function screenshot(cdp: CdpLike, clip: DocBox, beyondViewport: boolean): Promise<Buffer> {
    const reply = await cdp.send("Page.captureScreenshot", {
        format: "png",
        clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: 1 },
        captureBeyondViewport: beyondViewport,
        fromSurface: true,
    });
    const data = reply && typeof reply === "object" && "data" in reply ? reply.data : undefined;
    if (typeof data !== "string") {
        throw new Error("Page.captureScreenshot returned no image");
    }

    return Buffer.from(data, "base64");
}

/** Brings the page to the part's state: navigation, ready, banners, fonts, settle, freeze, steps. */
async function prepare(cdp: CdpLike, part: ShotPart, setup: PageSetup): Promise<string[]> {
    if (setup.viewport) {
        await cdp.send("Emulation.setDeviceMetricsOverride", {
            width: setup.viewport.width,
            height: setup.viewport.height,
            deviceScaleFactor: setup.viewport.scale,
            mobile: false,
        });
    }

    if (part.url !== undefined) {
        const url = setup.base ? new URL(part.url, setup.base).toString() : part.url;
        // a failed navigation resolves with errorText (net::ERR_CONNECTION_REFUSED), it does not reject
        const reply = await cdp.send("Page.navigate", { url });
        const errorText =
            reply && typeof reply === "object" && "errorText" in reply && typeof reply.errorText === "string"
                ? reply.errorText
                : "";
        if (errorText) {
            return [`navigate ${url}: ${errorText}`];
        }

        if (!(await untilLoaded(cdp, setup.readyTimeoutMs))) {
            return [`navigate ${url}: the page did not finish loading within ${setup.readyTimeoutMs} ms`];
        }
    }

    if (part.ready) {
        const ready = await untilResolved(cdp, part.ready, setup.readyTimeoutMs);
        if (!ready.ok) {
            return [`ready: ${describeMiss(ready)} within ${setup.readyTimeoutMs} ms`];
        }
    }

    for (const banner of setup.dismiss) {
        await act(cdp, banner, "click");
    }

    await evaluateExpression(cdp, "document.fonts.ready.then(() => true)");
    await sleep(setup.settleMs);
    if (setup.freeze) {
        await callInPage(cdp, freezeShotPage, { styleId: FREEZE_STYLE_ID });
    }

    for (const [index, step] of part.steps.entries()) {
        if ("wait" in step) {
            await sleep(step.wait);
            continue;
        }

        const resolution =
            "until" in step
                ? await untilResolved(cdp, step.until, setup.readyTimeoutMs)
                : await act(cdp, "click" in step ? step.click : step.scroll, "click" in step ? "click" : "scroll");
        if (!resolution.ok) {
            return [`step ${index}: ${describeMiss(resolution)}`];
        }
    }

    return [];
}

export interface PlacedMark {
    mark: Mark;
    frame: ShotFramePaint;
    chip?: { spec: ShotChipPaint; placed: PlacedLabel };
}

/**
 * Takes the raw and the annotated PNG of one part. A locator that matches nothing, or a label with no free spot
 * inside the clip, fails the part with its name, and nothing is drawn. The overlay and the freeze style are removed
 * also when something throws.
 */
interface PartPlan {
    clip: DocBox;
    placed: PlacedMark[];
    font: string;
    notes: string[];
}

type Planned = { ok: true; plan: PartPlan } | { ok: false; problems: string[] };

/** Everything before the screenshots: the page state, every locator, the clip and the spot of each label. */
async function planPart(cdp: CdpLike, part: ShotPart, setup: PageSetup): Promise<Planned> {
    const problems = await prepare(cdp, part, setup);
    if (problems.length > 0) {
        return { ok: false, problems };
    }

    const around = part.clip.around;
    const hits = await resolveLocators(cdp, [...(around ? [around] : []), ...part.marks.map((mark) => mark.target)]);
    const aroundHit = around ? hits[0] : undefined;
    const markHits = around ? hits.slice(1) : hits;
    const misses = [
        ...(aroundHit && !aroundHit.ok ? [`clip: ${describeMiss(aroundHit)}`] : []),
        ...markHits.flatMap((hit, index) => (hit.ok ? [] : [`mark ${index}: ${describeMiss(hit)}`])),
    ];
    if (misses.length > 0) {
        return { ok: false, problems: misses };
    }

    const metrics = await callInPage(cdp, readShotPageMetrics, undefined);
    let clip = clipOf(part, aroundHit?.ok ? aroundHit.box : undefined, metrics);
    // every hit is ok here (a miss returned above), so `boxes` lines up with `part.marks`
    const boxes = markHits.flatMap((hit) => (hit.ok ? [grow(hit.box, FRAME_PAD)] : []));
    const labelled = part.marks.flatMap((mark, index) => (mark.label?.text ? [{ mark, index }] : []));
    const styles = labelled.map(({ mark }) => chipStyleOf(mark, presetOf(mark, setup)));
    const sizes = await callInPage(cdp, measureShotChips, {
        chips: labelled.map(({ mark }, i) => ({ text: mark.label?.text ?? "", style: styles[i] })),
        font: metrics.font,
    });
    const page = { x: 0, y: 0, w: metrics.document.w, h: metrics.document.h };
    const text = await textRects(cdp, part.clip.fitLabels ? page : clip);
    const taken: DocBox[] = [];
    const placed: PlacedMark[] = part.marks.map((mark, index) => ({
        mark,
        frame: frameOf(mark, boxes[index], presetOf(mark, setup)),
    }));
    const notes: string[] = [];

    for (const [i, { mark, index }] of labelled.entries()) {
        const own = boxes[index];
        const others = boxes.filter((_, other) => other !== index);
        const request: LabelRequest = {
            rect: own,
            size: sizes[i],
            position: mark.label?.position ?? "top-left",
            gap: LABEL_GAP,
            offset: mark.label?.offset,
            leader: mark.label?.leader,
        };
        const obstacles = [
            ...text.filter(
                (rect) =>
                    !(
                        rect.x >= own.x &&
                        rect.y >= own.y &&
                        rect.x + rect.w <= own.x + own.w &&
                        rect.y + rect.h <= own.y + own.h
                    )
            ),
            ...others,
            ...taken,
        ];
        const placement = placeLabel({ request, bounds: part.clip.fitLabels ? page : clip, obstacles });
        if (!placement.ok) {
            problems.push(
                `mark ${index} label "${mark.label?.text.split("\n")[0]}": no free spot ${part.clip.fitLabels ? "on the page" : "inside the clip"} (tried ${placement.tried.join(", ")})`
            );
            continue;
        }

        if (placement.label.moved) {
            notes.push(`mark ${index} label moved from ${request.position} to ${placement.label.position}`);
        }

        taken.push(placement.label.chip);
        const { x, y } = placement.label.chip;
        placed[index].chip = {
            spec: { text: mark.label?.text ?? "", style: styles[i], at: { x, y } },
            placed: placement.label,
        };
    }

    if (problems.length > 0) {
        return { ok: false, problems };
    }

    if (part.clip.fitLabels) {
        clip = snap(intersect(unionOf([clip, ...taken.map((chip) => grow(chip, 4))]), page));
    }

    return { ok: true, plan: { clip, placed, font: metrics.font, notes } };
}

/** The overlay and the freeze style go also when the work throws. */
async function cleared<T>(cdp: CdpLike, work: () => Promise<T>): Promise<T> {
    try {
        return await work();
    } finally {
        await callInPage(cdp, clearShotOverlay, { overlayId: SHOT_OVERLAY_ID, styleId: FREEZE_STYLE_ID }).catch(
            () => undefined
        );
    }
}

/** A dry run: the page state, the locators and the labels, without a screenshot. Steps still click. */
export async function rehearsePart(
    cdp: CdpLike,
    part: ShotPart,
    setup: PageSetup = DEFAULT_SETUP
): Promise<{ ok: true; notes: string[]; clip: DocBox } | { ok: false; problems: string[] }> {
    return cleared(cdp, async () => {
        const planned = await planPart(cdp, part, setup);
        return planned.ok ? { ok: true, notes: planned.plan.notes, clip: planned.plan.clip } : planned;
    });
}

export async function capturePart(
    cdp: CdpLike,
    part: ShotPart,
    setup: PageSetup = DEFAULT_SETUP
): Promise<PartCapture> {
    return cleared(cdp, async () => {
        const planned = await planPart(cdp, part, setup);
        if (!planned.ok) {
            return planned;
        }

        const { clip, placed, font, notes } = planned.plan;
        const raw = await screenshot(cdp, clip, !part.clip.viewport);
        const leaders: ShotLeaderPaint[] = placed.flatMap((entry) =>
            entry.chip?.placed.leader ? [{ ...entry.chip.placed.leader, color: entry.chip.spec.style.bg }] : []
        );
        const chips = placed.flatMap((entry) => (entry.chip ? [entry.chip.spec] : []));
        const painted = await callInPage(cdp, paintShotOverlay, {
            overlayId: SHOT_OVERLAY_ID,
            font,
            frames: placed.map((entry) => entry.frame),
            chips,
            leaders,
        });
        const annotated = await screenshot(cdp, clip, !part.clip.viewport);
        const size = checkImageDimensions({ data: raw, maxPixels: 400_000_000 });
        const scale = size.width / clip.w;
        const areas = [
            ...placed.flatMap((entry) => shotFrameArea(entry.frame)),
            ...placed.flatMap((entry) => (entry.chip ? [grow(entry.chip.placed.chip, 1)] : [])),
            ...leaders.map(leaderArea),
        ]
            .map((box) => toImage(box, clip, scale))
            .filter(
                (rect) => rect.w > 0 && rect.h > 0 && rectsOverlap(rect, { x: 0, y: 0, w: size.width, h: size.height })
            );

        return {
            ok: true,
            notes,
            images: {
                raw,
                annotated,
                painted: areas,
                annotations: placed.map((entry) => annotationOf(entry, clip, scale)),
                clip,
                scale,
                width: size.width,
                height: size.height,
                font: painted.font,
            },
        };
    });
}

/**
 * One mark as a pixel annotation of the final image: the frame and chip styles as they were drawn (the setup's preset
 * filled in, sizes in the image's pixels), and the label's `offset` from its position's spot to where the chip was
 * placed, so a replay of the plan draws the same look in the same place.
 */
export function annotationOf(entry: PlacedMark, clip: DocBox, scale: number): Annotation {
    const rect = toImage(entry.frame.box, clip, scale);
    const { frame } = entry;
    const style = {
        stroke: frame.stroke,
        strokeWidth: frame.strokeWidth * scale,
        radius: frame.radius * scale,
        fill: frame.fill,
        ...(frame.dash.length > 0 ? { dash: frame.dash.map((step) => step * scale) } : {}),
    };
    let label: ShapeLabel | undefined;

    if (entry.chip) {
        const chip = toImage(entry.chip.placed.chip, clip, scale);
        const { position } = entry.chip.placed;
        const leader = entry.mark.label?.leader;
        const spot = labelSpot(
            { rect, size: { w: chip.w, h: chip.h }, position, gap: LABEL_GAP * scale, leader },
            position
        );
        const chipStyle = entry.chip.spec.style;
        label = {
            text: entry.chip.spec.text,
            position,
            style: { bg: chipStyle.bg, fg: chipStyle.fg, fontSize: chipStyle.fontSize * scale },
            offset: { x: chip.x - spot.x, y: chip.y - spot.y },
            ...(leader !== undefined ? { leader } : {}),
        };
    }

    return {
        kind: entry.mark.kind,
        rect,
        ...(entry.mark.preset ? { preset: entry.mark.preset } : {}),
        style,
        ...(label ? { label } : {}),
    };
}
