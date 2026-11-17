import { useEffect, useRef } from "react";
import { parseCssColor, type Rgb } from "../../color";
import { resolveCssColor, useColorSchemeTick } from "../../theme";
import { alignedSize, type CompareSize, overlapRect, placeImage, type RgbaImage, type Shift } from "../core";
import { createIdleCache } from "../load";
import {
    AlignControl,
    appliedShift,
    type CompareMode,
    ComparePane,
    type CompareStageProps,
    type IdleResult,
    isAligned,
    PixelNotice,
    StageImage,
    useIdleCompute,
    ViewLayer,
} from "../stage";

/** The ramp from a small to a large colour distance, in kit tones. */
const STOPS = ["--info", "--ok", "--warn", "--err"] as const;
/** sRGB stand-ins for a page whose template defines no tone tokens. */
const FALLBACK: Record<(typeof STOPS)[number], Rgb> = {
    "--info": { r: 59, g: 130, b: 246 },
    "--ok": { r: 34, g: 160, b: 90 },
    "--warn": { r: 230, g: 160, b: 20 },
    "--err": { r: 225, g: 50, b: 60 },
};
/** Distances under this share of the largest stay clear, so compression noise does not tint the whole page. */
const FLOOR = 0.02;
/** pixelmatch's largest YIQ colour distance. */
const MAX_YIQ_DELTA = 35215;
const heatCache = createIdleCache<HeatMap>(4);

interface HeatMap {
    size: CompareSize;
    data: Uint8ClampedArray<ArrayBuffer>;
    /** Pixels at or above the floor. */
    changed: number;
    total: number;
}

function blend(value: number, alpha: number): number {
    return 255 + ((value - 255) * alpha) / 255;
}

/** pixelmatch's YIQ colour distance of one pixel pair, both blended over white, as a share of the largest. */
function colourDistance(p: Uint8ClampedArray, q: Uint8ClampedArray, at: number): number {
    const r1 = blend(p[at], p[at + 3]);
    const g1 = blend(p[at + 1], p[at + 3]);
    const b1 = blend(p[at + 2], p[at + 3]);
    const r2 = blend(q[at], q[at + 3]);
    const g2 = blend(q[at + 1], q[at + 3]);
    const b2 = blend(q[at + 2], q[at + 3]);
    const dy = 0.29889531 * (r1 - r2) + 0.58662247 * (g1 - g2) + 0.11448223 * (b1 - b2);
    const di = 0.59597799 * (r1 - r2) - 0.2741761 * (g1 - g2) - 0.32180189 * (b1 - b2);
    const dq = 0.21147017 * (r1 - r2) - 0.52261711 * (g1 - g2) + 0.31114694 * (b1 - b2);

    return Math.sqrt((0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq) / MAX_YIQ_DELTA);
}

function rampAt(stops: Rgb[], t: number): Rgb {
    const at = Math.min(stops.length - 1, Math.max(0, t) * (stops.length - 1));
    const low = Math.floor(at);
    const high = Math.min(stops.length - 1, low + 1);
    const mix = at - low;

    return {
        r: stops[low].r + (stops[high].r - stops[low].r) * mix,
        g: stops[low].g + (stops[high].g - stops[low].g) * mix,
        b: stops[low].b + (stops[high].b - stops[low].b) * mix,
    };
}

/**
 * Every pixel's colour distance on the ramp. Unshifted, a pixel inside only one image is the largest distance; on an
 * aligned pair only the overlap is drawn, as the diff compares it.
 */
function heatMap({ a, b, shift, stops }: { a: RgbaImage; b: RgbaImage; shift: Shift; stops: Rgb[] }): HeatMap {
    const size = alignedSize(a, b, shift);
    const placedA = placeImage(a, size);
    const placedB = placeImage(b, size, { x: -shift.dx, y: -shift.dy });
    const aligned = shift.dx !== 0 || shift.dy !== 0;
    const area = overlapRect(a, b, shift);
    const pixels = size.width * size.height;
    // The map covers the whole canvas; on an aligned pair the share counts the overlap only.
    const total = aligned ? area.w * area.h : pixels;
    const data = new Uint8ClampedArray(pixels * 4);
    let changed = 0;

    for (let i = 0; i < pixels; i++) {
        const at = i * 4;
        const inA = placedA.data[at + 3] > 0;
        const inB = placedB.data[at + 3] > 0;

        if ((!inA && !inB) || (aligned && inA !== inB)) {
            continue;
        }

        const t = inA !== inB ? 1 : colourDistance(placedA.data, placedB.data, at);

        if (t < FLOOR) {
            continue;
        }

        changed++;
        const colour = rampAt(stops, t);
        data[at] = colour.r;
        data[at + 1] = colour.g;
        data[at + 2] = colour.b;
        // A larger distance is also more opaque, so a faint change stays faint.
        data[at + 3] = 110 + 145 * Math.min(1, t * 2);
    }

    return { size, data, changed, total };
}

/** The ramp's colours as the page's theme resolves them now. */
function resolvedStops(): Rgb[] {
    return STOPS.map((name) => parseCssColor(resolveCssColor(name)) ?? FALLBACK[name]);
}

function useHeat(props: CompareStageProps): { result: IdleResult<HeatMap>; shift: Shift } {
    const shift = appliedShift(props);
    // The ramp uses resolved theme colours, so a light or dark flip draws it again.
    const scheme = useColorSchemeTick();
    const group = `${props.a.src}\n${props.b.src}`;
    const pair = props.pixels.status === "ready" ? props.pixels.pair : null;
    const result = useIdleCompute({
        cache: heatCache,
        group,
        job: pair
            ? {
                  key: `${group}\n${shift.dx},${shift.dy}\n${scheme}`,
                  compute: () => heatMap({ a: pair.a, b: pair.b, shift, stops: resolvedStops() }),
              }
            : null,
    });

    return { result, shift };
}

function HeatCanvas({ heat }: { heat: HeatMap }) {
    const ref = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        ref.current?.getContext("2d")?.putImageData(new ImageData(heat.data, heat.size.width, heat.size.height), 0, 0);
    }, [heat]);

    return (
        <canvas
            ref={ref}
            width={heat.size.width}
            height={heat.size.height}
            className="absolute left-0 top-0"
            style={{ width: heat.size.width, height: heat.size.height, imageRendering: "pixelated" }}
        />
    );
}

/** How far each pixel's colour moved, on a ramp from a small change to a large one, over the faded After image. */
function HeatStage(props: CompareStageProps) {
    const { result, shift } = useHeat(props);
    const heat = result.status === "ready" ? result.value : null;

    return (
        <ComparePane
            stage={props}
            label={`Colour distance of ${props.a.label} and ${props.b.label}`}
            canvas={heat?.size}
            caption={`Colour distance over ${props.b.label}`}
        >
            <ViewLayer>
                <StageImage image={props.b} at={{ x: -shift.dx, y: -shift.dy }} className="opacity-30 grayscale" />
                {heat ? <HeatCanvas heat={heat} /> : null}
            </ViewLayer>
            <PixelNotice pixels={props.pixels} computing={result.status === "loading"} />
        </ComparePane>
    );
}

function HeatControls(props: CompareStageProps) {
    const { result, shift } = useHeat(props);
    const heat = result.status === "ready" ? result.value : null;
    const share = heat ? (heat.changed / Math.max(1, heat.total)) * 100 : 0;

    return (
        <>
            <span className="flex items-center gap-2 text-xs text-dim">
                <span>Small change</span>
                <span
                    aria-hidden="true"
                    className="inline-block h-2.5 w-32 rounded-full border border-line"
                    style={{ background: `linear-gradient(90deg, ${STOPS.map((name) => `var(${name})`).join(", ")})` }}
                />
                <span>Large change</span>
                <span>
                    {isAligned(shift) ? "(clear: no change)" : "(clear: no change; inside only one image: largest)"}
                </span>
            </span>
            <AlignControl {...props} />
            <span aria-live="polite" className="text-xs text-dim">
                {heat && result.status === "ready" ? (
                    <>
                        <span className="font-medium text-ink">
                            {`${share >= 10 ? share.toFixed(1) : share.toFixed(2)}% of pixels changed colour`}
                        </span>
                        {`${isAligned(shift) ? " on the aligned pair, where both overlap," : ""} in ${Math.round(result.ms)} ms`}
                    </>
                ) : props.pixels.status === "error" ? null : (
                    "Computing the heat map..."
                )}
            </span>
        </>
    );
}

export const heatMode: CompareMode = {
    id: "heat",
    label: "Heat",
    Stage: HeatStage,
    Controls: HeatControls,
    needsPixels: true,
};
