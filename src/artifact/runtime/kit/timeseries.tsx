import {
    type KeyboardEvent as ReactKeyboardEvent,
    type MouseEvent as ReactMouseEvent,
    type ReactNode,
    type PointerEvent as ReactPointerEvent,
    useCallback,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
} from "react";
import { TONE_COLOR } from "./charts";
import { Md } from "./md";
import type { Tone } from "./primitives";
import {
    assignPanels,
    clampRange,
    clusterMarkers,
    DAY,
    decimate,
    decodeViewState,
    emptyViewState,
    encodeViewState,
    extentIn,
    formatDurationShort,
    formatForUnit,
    formatTime,
    HOUR,
    laneGutterWidth,
    layoutLanes,
    layoutLanesIn,
    logScale,
    MINUTE,
    NO_UNIT,
    nearestIndex,
    niceScale,
    panRange,
    rangeAround,
    readHashState,
    SECOND,
    stackPoints,
    type TimeTick,
    type TsPoint,
    type TsRange,
    type TsViewState,
    timeTicks,
    toCsv,
    valueAt,
    writeHashState,
    zoomRange,
} from "./timeseries-core";

/**
 * Interactive time-series chart for dense time data (tens of thousands of
 * points per series). Canvas rendering with DOM axes, legend and tooltips;
 * wheel / pinch zoom, drag pan, box zoom, a brush strip, presets, keyboard;
 * markers in a clustered band; spans as Gantt-like lanes; synced crosshair and
 * viewport across charts with the same `syncId`; viewer choices persisted per `id`.
 */

export interface TsSeries {
    id: string;
    label: string;
    /** [epoch ms, value]; null = gap. Sorted by time. */
    points: Array<[number, number | null]>;
    /** Series with the same unit can share a y axis; e.g. "tokens", "usd", "%". */
    unit?: string;
    tone?: Tone;
    color?: string;
    kind?: "line" | "step" | "area" | "bar" | "scatter";
    /** Series with the same stack id stack (area or bar). */
    stack?: string;
    /** Initial panel; series with the same group share a panel in split layout. Default: unit. */
    group?: string;
    /** Initially off; the viewer can turn it on. */
    hidden?: boolean;
    dashed?: boolean;
}

export interface TsMarker {
    t: number;
    label: string;
    kind: string;
    tone?: Tone;
    color?: string;
    /** Markdown. */
    detail?: string;
}

export interface TsSpan {
    id?: string;
    start: number;
    end: number;
    label: string;
    lane?: string;
    kind: string;
    tone?: Tone;
    color?: string;
    /** Markdown. */
    detail?: string;
}

export interface TsUnitConfig {
    label?: string;
    format?: (v: number) => string;
    log?: boolean;
}

export interface TimeSeriesProps {
    /** Persists the viewer's choices (series on/off, layout, range) in localStorage and the URL hash. */
    id?: string;
    title?: string;
    series: TsSeries[];
    markers?: TsMarker[];
    spans?: TsSpan[];
    /** Initial visible range; default = all data. */
    range?: [number, number];
    /** Initial layout; the viewer can switch. */
    layout?: "combined" | "split";
    /** Height of one panel (px). */
    height?: number;
    /** Default "Europe/Prague". */
    timeZone?: string;
    /** Charts with the same syncId share the viewport and the crosshair. */
    syncId?: string;
    units?: Record<string, TsUnitConfig>;
    /** Height cap of the span lanes area (px, default 220). */
    lanesHeight?: number;
    /** Show the overview brush strip (default true). */
    brush?: boolean;
}

// ─── Colors ───

const PALETTE = ["var(--info)", "var(--warn)", "var(--ok)", "var(--err)", "var(--accent)"];
const EXTRA_PALETTE = ["#d4885c", "#4fa89c", "#c27c9e", "#9aa65c", "#7f8fd6", "#c9a14a"];

function paletteColor(index: number): string {
    return index < PALETTE.length ? PALETTE[index] : EXTRA_PALETTE[(index - PALETTE.length) % EXTRA_PALETTE.length];
}

function cssColor(item: { color?: string; tone?: Tone }, index: number): string {
    return item.color ?? (item.tone ? TONE_COLOR[item.tone] : paletteColor(index));
}

interface Theme {
    bg: string;
    panel: string;
    border: string;
    text: string;
    dim: string;
    accent: string;
    font: string;
    resolve: (css: string) => string;
}

function readTheme(el: Element): Theme {
    const styles = window.getComputedStyle(el);
    const cache = new Map<string, string>();
    const prop = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
    const resolve = (css: string): string => {
        const hit = cache.get(css);

        if (hit) {
            return hit;
        }

        const m = /^var\((--[\w-]+)\)$/.exec(css.trim());
        const value = m ? prop(m[1], "#8a93a4") : css;
        cache.set(css, value);

        return value;
    };

    return {
        bg: prop("--bg", "#0d0f13"),
        panel: prop("--panel", "#151920"),
        border: prop("--border", "#252b36"),
        text: prop("--text", "#e2e6ec"),
        dim: prop("--dim", "#8a93a4"),
        accent: prop("--accent", "#4dd0b1"),
        font: prop("--font-body", "ui-sans-serif, system-ui, sans-serif"),
        resolve,
    };
}

// ─── Sync bus ───

interface SyncMessage {
    from: string;
    range?: TsRange;
    hover?: number | null;
}

const syncBuses = new Map<string, Set<(m: SyncMessage) => void>>();

function syncSubscribe(syncId: string, listener: (m: SyncMessage) => void): () => void {
    const set = syncBuses.get(syncId) ?? new Set();
    set.add(listener);
    syncBuses.set(syncId, set);

    return () => {
        set.delete(listener);
    };
}

function syncPublish(syncId: string, message: SyncMessage): void {
    for (const listener of syncBuses.get(syncId) ?? []) {
        listener(message);
    }
}

// ─── Layout ───

const GUTTER_MIN = 76;
const GUTTER_RIGHT_AXIS = 60;
const GUTTER_RIGHT = 14;
const MARKER_BAND = 26;
const PANEL_GAP = 12;
const TIME_AXIS = 24;
const LANE_GAP = 6;
const BRUSH_HEIGHT = 40;
const MIN_SPAN = 5 * SECOND;
const PRESETS: Array<{ label: string; span: number | null }> = [
    { label: "15m", span: 15 * MINUTE },
    { label: "1h", span: HOUR },
    { label: "6h", span: 6 * HOUR },
    { label: "1d", span: DAY },
    { label: "7d", span: 7 * DAY },
    { label: "All", span: null },
];
const GLYPHS = ["circle", "diamond", "triangle", "square"] as const;
type Glyph = (typeof GLYPHS)[number];

interface AxisFrame {
    unit: string;
    label: string;
    side: "left" | "right";
    log: boolean;
    min: number;
    max: number;
    ticks: number[];
    format: (v: number) => string;
}

interface SeriesFrame {
    s: TsSeries;
    index: number;
    color: string;
    kind: NonNullable<TsSeries["kind"]>;
    /** Full-resolution source in plotted space (stacked when stacked). */
    src: readonly TsPoint[];
    /** Stacked layers: the cumulative layers below, at the same times. */
    base: readonly TsPoint[] | null;
    /** Decimated points to draw (normalized when normalizing). */
    pts: TsPoint[];
    /** Normalize divisor (1 when off). */
    scale: number;
    stacked: boolean;
    axis: AxisFrame;
}

interface PanelFrame {
    key: string;
    top: number;
    height: number;
    axes: AxisFrame[];
    series: SeriesFrame[];
}

interface LaneFrame {
    name: string;
    top: number;
    rowHeight: number;
    rows: number;
    height: number;
    /** [span index, sub-row]. */
    items: Array<[number, number]>;
}

interface Frame {
    width: number;
    gutterLeft: number;
    plotLeft: number;
    plotRight: number;
    plotWidth: number;
    view: TsRange;
    markerTop: number;
    markerHeight: number;
    panels: PanelFrame[];
    panelsTop: number;
    panelsBottom: number;
    axisTop: number;
    lanesTop: number;
    lanesHeight: number;
    lanes: LaneFrame[];
    height: number;
    ticks: TimeTick[];
    /** Visible marker indexes (time order) and their clusters. */
    markerOrder: number[];
    clusters: Array<{ x: number; items: number[] }>;
}

function toX(frame: Pick<Frame, "plotLeft" | "plotWidth" | "view">, t: number): number {
    return frame.plotLeft + ((t - frame.view[0]) / (frame.view[1] - frame.view[0])) * frame.plotWidth;
}

function toT(frame: Pick<Frame, "plotLeft" | "plotWidth" | "view">, x: number): number {
    return frame.view[0] + ((x - frame.plotLeft) / frame.plotWidth) * (frame.view[1] - frame.view[0]);
}

function toY(panel: PanelFrame, axis: AxisFrame, v: number | null): number | null {
    if (v === null || !Number.isFinite(v)) {
        return null;
    }

    const padTop = 8;
    const inner = panel.height - padTop - 2;
    let ratio: number;

    if (axis.log) {
        if (v <= 0) {
            return null;
        }

        ratio = (Math.log10(v) - Math.log10(axis.min)) / (Math.log10(axis.max) - Math.log10(axis.min));
    } else {
        ratio = (v - axis.min) / (axis.max - axis.min || 1);
    }

    return panel.top + padTop + (1 - ratio) * inner;
}

function baselineY(panel: PanelFrame, axis: AxisFrame): number {
    const base = axis.log ? axis.min : Math.min(Math.max(0, axis.min), axis.max);

    return toY(panel, axis, base) ?? panel.top + panel.height;
}

function boundsOf(series: TsSeries[], markers: TsMarker[], spans: TsSpan[]): TsRange {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;

    for (const s of series) {
        if (s.points.length) {
            lo = Math.min(lo, s.points[0][0]);
            hi = Math.max(hi, s.points[s.points.length - 1][0]);
        }
    }

    for (const m of markers) {
        lo = Math.min(lo, m.t);
        hi = Math.max(hi, m.t);
    }

    for (const sp of spans) {
        lo = Math.min(lo, sp.start);
        hi = Math.max(hi, sp.end);
    }

    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
        const now = Date.now();

        return [now - HOUR, now];
    }

    if (hi - lo < MIN_SPAN) {
        return [lo - MIN_SPAN, hi + MIN_SPAN];
    }

    return [lo, hi];
}

// ─── Persistence ───

const STORAGE_PREFIX = "artifact-ts:";

function loadViewState(id: string | undefined): TsViewState {
    if (!id || typeof window === "undefined") {
        return emptyViewState();
    }

    const fromHash = readHashState(window.location.hash, id);

    if (fromHash !== null) {
        return decodeViewState(fromHash);
    }

    try {
        const stored = window.localStorage?.getItem(STORAGE_PREFIX + id);

        return stored ? decodeViewState(stored) : emptyViewState();
    } catch {
        return emptyViewState();
    }
}

function saveViewState(id: string, state: TsViewState): void {
    const encoded = encodeViewState(state);

    try {
        window.localStorage?.setItem(STORAGE_PREFIX + id, encoded);
    } catch {
        // Storage can be full or disabled (private mode); the hash still carries the state.
    }

    // A file:// page may use the hash as its route, so only http(s) pages get a hash entry.
    if (window.location.protocol === "file:") {
        return;
    }

    const next = writeHashState(window.location.hash, id, encoded);

    if (next !== window.location.hash) {
        window.history.replaceState(
            window.history.state,
            "",
            `${window.location.pathname}${window.location.search}${next}`
        );
    }
}

// ─── Drawing ───

function setupCanvas(canvas: HTMLCanvasElement, width: number, height: number): CanvasRenderingContext2D | null {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));

    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
    }

    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");

    if (!ctx) {
        return null;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    return ctx;
}

function drawGlyph(ctx: CanvasRenderingContext2D, glyph: Glyph, x: number, y: number, r: number): void {
    ctx.beginPath();

    if (glyph === "circle") {
        ctx.arc(x, y, r, 0, Math.PI * 2);
    } else if (glyph === "diamond") {
        ctx.moveTo(x, y - r - 1);
        ctx.lineTo(x + r + 1, y);
        ctx.lineTo(x, y + r + 1);
        ctx.lineTo(x - r - 1, y);
        ctx.closePath();
    } else if (glyph === "triangle") {
        ctx.moveTo(x, y - r - 1);
        ctx.lineTo(x + r + 1, y + r);
        ctx.lineTo(x - r - 1, y + r);
        ctx.closePath();
    } else {
        ctx.rect(x - r, y - r, r * 2, r * 2);
    }

    ctx.fill();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
}

function tracePath(
    ctx: CanvasRenderingContext2D,
    frame: Frame,
    panel: PanelFrame,
    sf: SeriesFrame
): Array<[number, number]> {
    const xy: Array<[number, number]> = [];
    let pen = false;
    let lastY = 0;
    ctx.beginPath();

    for (const [t, v] of sf.pts) {
        const y = toY(panel, sf.axis, v);

        if (y === null) {
            pen = false;

            continue;
        }

        const x = toX(frame, t);

        if (!pen) {
            ctx.moveTo(x, y);
            pen = true;
        } else if (sf.kind === "step") {
            ctx.lineTo(x, lastY);
            ctx.lineTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }

        xy.push([x, y]);
        lastY = y;
    }

    return xy;
}

/** Fill under each pen-down run of a line down to the axis baseline. */
function fillUnder(ctx: CanvasRenderingContext2D, frame: Frame, panel: PanelFrame, sf: SeriesFrame): void {
    const base = baselineY(panel, sf.axis);
    let run: Array<[number, number]> = [];
    const flush = () => {
        if (run.length < 2) {
            run = [];

            return;
        }

        ctx.beginPath();
        ctx.moveTo(run[0][0], base);

        for (const [i, [x, y]] of run.entries()) {
            if (sf.kind === "step" && i > 0) {
                ctx.lineTo(x, run[i - 1][1]);
            }

            ctx.lineTo(x, y);
        }

        ctx.lineTo(run[run.length - 1][0], base);
        ctx.closePath();
        ctx.fill();
        run = [];
    };

    for (const [t, v] of sf.pts) {
        const y = toY(panel, sf.axis, v);

        if (y === null) {
            flush();

            continue;
        }

        run.push([toX(frame, t), y]);
    }

    flush();
}

function barWidth(frame: Frame, pts: readonly TsPoint[]): number {
    if (pts.length < 2) {
        return 6;
    }

    const gaps: number[] = [];

    for (let i = 1; i < pts.length && gaps.length < 200; i += 1) {
        gaps.push(pts[i][0] - pts[i - 1][0]);
    }

    gaps.sort((a, b) => a - b);
    const px = (gaps[gaps.length >> 1] / (frame.view[1] - frame.view[0])) * frame.plotWidth;

    return Math.max(1, Math.min(24, px * 0.8));
}

interface DrawInput {
    frame: Frame;
    theme: Theme;
    markers: TsMarker[];
    spans: TsSpan[];
    markerColor: (m: TsMarker) => string;
    markerGlyph: (kind: string) => Glyph;
    spanColor: (s: TsSpan) => string;
}

function drawMain(
    ctx: CanvasRenderingContext2D,
    { frame, theme, markers, spans, markerColor, markerGlyph, spanColor }: DrawInput
) {
    const { plotLeft, plotRight, plotWidth } = frame;
    ctx.font = `11px ${theme.font}`;
    ctx.textBaseline = "middle";

    for (const panel of frame.panels) {
        ctx.save();
        ctx.fillStyle = theme.panel;
        ctx.globalAlpha = 0.45;
        ctx.fillRect(plotLeft, panel.top, plotWidth, panel.height);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = theme.border;
        ctx.lineWidth = 1;
        const gridAxis = panel.axes[0];

        for (const v of gridAxis?.ticks ?? []) {
            const y = toY(panel, gridAxis, v);

            if (y === null || y < panel.top - 0.5 || y > panel.top + panel.height + 0.5) {
                continue;
            }

            ctx.globalAlpha = 0.55;
            ctx.beginPath();
            ctx.moveTo(plotLeft, Math.round(y) + 0.5);
            ctx.lineTo(plotRight, Math.round(y) + 0.5);
            ctx.stroke();
        }

        for (const tick of frame.ticks) {
            const x = Math.round(toX(frame, tick.t)) + 0.5;
            ctx.globalAlpha = tick.major ? 0.9 : 0.4;
            ctx.beginPath();
            ctx.moveTo(x, panel.top);
            ctx.lineTo(x, panel.top + panel.height);
            ctx.stroke();
        }

        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.rect(plotLeft, panel.top, plotWidth, panel.height);
        ctx.clip();

        const layers = [...panel.series].sort((a, b) => layerRank(a) - layerRank(b));
        const stackedFills = layers.filter((sf) => sf.stacked && sf.kind === "area").reverse();

        for (const sf of stackedFills) {
            ctx.fillStyle = theme.bg;
            fillUnder(ctx, frame, panel, sf);
            ctx.fillStyle = theme.resolve(sf.color);
            ctx.globalAlpha = 0.38;
            fillUnder(ctx, frame, panel, sf);
            ctx.globalAlpha = 1;
        }

        for (const sf of layers) {
            const color = theme.resolve(sf.color);
            ctx.strokeStyle = color;
            ctx.fillStyle = color;
            ctx.lineWidth = 1.5;
            ctx.lineJoin = "round";
            ctx.setLineDash(sf.s.dashed ? [5, 4] : []);

            if (sf.kind === "bar") {
                const w = barWidth(frame, sf.pts);
                ctx.globalAlpha = 0.85;

                for (const [t, v] of sf.pts) {
                    const y = toY(panel, sf.axis, v);

                    if (y === null) {
                        continue;
                    }

                    const baseV = sf.base ? (valueAt(sf.base, t) ?? 0) / sf.scale : null;
                    const y0 = baseV === null ? baselineY(panel, sf.axis) : (toY(panel, sf.axis, baseV) ?? y);
                    const x = toX(frame, t);
                    ctx.fillRect(x - w / 2, Math.min(y, y0), w, Math.max(1, Math.abs(y0 - y)));
                }

                ctx.globalAlpha = 1;

                continue;
            }

            if (sf.kind === "scatter") {
                const r = sf.pts.length > 3000 ? 1.2 : 2.2;

                for (const [t, v] of sf.pts) {
                    const y = toY(panel, sf.axis, v);

                    if (y !== null) {
                        ctx.beginPath();
                        ctx.arc(toX(frame, t), y, r, 0, Math.PI * 2);
                        ctx.fill();
                    }
                }

                continue;
            }

            if (sf.kind === "area" && !sf.stacked) {
                ctx.globalAlpha = 0.12;
                fillUnder(ctx, frame, panel, sf);
                ctx.globalAlpha = 1;
            }

            tracePath(ctx, frame, panel, sf);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        ctx.restore();
    }

    // Marker lines through the panels, glyphs and counts in the band above.
    if (frame.markerHeight > 0 && frame.clusters.length) {
        const bandMid = frame.markerTop + frame.markerHeight / 2;
        ctx.save();
        ctx.beginPath();
        ctx.rect(plotLeft - 8, frame.markerTop, plotWidth + 16, frame.panelsBottom - frame.markerTop);
        ctx.clip();
        ctx.setLineDash([2, 3]);
        ctx.lineWidth = 1;

        for (const i of frame.markerOrder) {
            const m = markers[i];
            const x = Math.round(toX(frame, m.t)) + 0.5;
            ctx.strokeStyle = theme.resolve(markerColor(m));
            ctx.globalAlpha = 0.2;
            ctx.beginPath();
            ctx.moveTo(x, frame.markerTop + frame.markerHeight);
            ctx.lineTo(x, frame.panelsBottom);
            ctx.stroke();
        }

        ctx.setLineDash([]);
        ctx.globalAlpha = 1;

        for (const [ci, cluster] of frame.clusters.entries()) {
            const next = frame.clusters[ci + 1]?.x ?? plotRight + 200;

            if (cluster.items.length === 1) {
                const m = markers[frame.markerOrder[cluster.items[0]]];
                ctx.fillStyle = theme.resolve(markerColor(m));
                drawGlyph(ctx, markerGlyph(m.kind), cluster.x, bandMid, 4);
                const room = next - cluster.x - 18;
                const width = ctx.measureText(m.label).width;

                if (room > width && cluster.x + 8 + width < plotRight + 4) {
                    ctx.fillStyle = theme.dim;
                    ctx.textAlign = "left";
                    ctx.fillText(m.label, cluster.x + 8, bandMid);
                }

                continue;
            }

            const label = String(cluster.items.length);
            const w = Math.max(18, ctx.measureText(label).width + 10);
            const counts = new Map<string, number>();

            for (const item of cluster.items) {
                const m = markers[frame.markerOrder[item]];
                counts.set(markerColor(m), (counts.get(markerColor(m)) ?? 0) + 1);
            }

            const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "var(--dim)";
            ctx.fillStyle = theme.resolve(dominant);
            ctx.globalAlpha = 0.22;
            roundRect(ctx, cluster.x - w / 2, bandMid - 8, w, 16, 8);
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.strokeStyle = theme.resolve(dominant);
            ctx.stroke();
            ctx.fillStyle = theme.text;
            ctx.textAlign = "center";
            ctx.fillText(label, cluster.x, bandMid + 0.5);
        }

        ctx.restore();
    }

    // Span lanes.
    if (frame.lanesHeight > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(plotLeft, frame.lanesTop, plotWidth, frame.lanesHeight);
        ctx.clip();

        for (const tick of frame.ticks) {
            const x = Math.round(toX(frame, tick.t)) + 0.5;
            ctx.strokeStyle = theme.border;
            ctx.globalAlpha = tick.major ? 0.8 : 0.35;
            ctx.beginPath();
            ctx.moveTo(x, frame.lanesTop);
            ctx.lineTo(x, frame.lanesTop + frame.lanesHeight);
            ctx.stroke();
        }

        ctx.globalAlpha = 1;
        ctx.textAlign = "left";

        for (const lane of frame.lanes) {
            ctx.fillStyle = theme.panel;
            ctx.globalAlpha = 0.5;
            ctx.fillRect(plotLeft, lane.top, plotWidth, lane.height);
            ctx.globalAlpha = 1;

            for (const [index, row] of lane.items) {
                const sp = spans[index];

                if (sp.end < frame.view[0] || sp.start > frame.view[1]) {
                    continue;
                }

                const x0 = Math.max(plotLeft - 2, toX(frame, sp.start));
                const x1 = Math.min(plotRight + 2, toX(frame, sp.end));
                const w = Math.max(2, x1 - x0);
                const y = lane.top + row * (lane.rowHeight + 2) + 1;
                const color = theme.resolve(spanColor(sp));
                ctx.fillStyle = color;
                ctx.globalAlpha = 0.82;
                roundRect(ctx, x0, y, w, lane.rowHeight, Math.min(3, lane.rowHeight / 3));
                ctx.fill();
                ctx.globalAlpha = 1;

                if (lane.rowHeight >= 12) {
                    const text = sp.label;
                    const tw = ctx.measureText(text).width;
                    const visible0 = Math.max(x0, plotLeft);
                    const visible1 = Math.min(x0 + w, plotRight);

                    if (visible1 - visible0 > tw + 8) {
                        ctx.fillStyle = theme.bg;
                        ctx.fillText(text, visible0 + 4, y + lane.rowHeight / 2 + 0.5);
                    }
                }
            }
        }

        ctx.restore();
    }
}

function layerRank(sf: SeriesFrame): number {
    return sf.kind === "area" ? 0 : sf.kind === "bar" ? 1 : sf.kind === "scatter" ? 3 : 2;
}

// ─── Component ───

/** Stable defaults: a fresh `[]` per render would change every memo that depends on them. */
const NO_MARKERS: TsMarker[] = [];
const NO_SPANS: TsSpan[] = [];

type Hover =
    | { region: "panel"; x: number; y: number; t: number }
    | { region: "marker"; x: number; y: number; cluster: number }
    | { region: "span"; x: number; y: number; span: number }
    | { region: "none"; x: number; y: number };

type Pin =
    | { kind: "time"; t: number; y: number }
    | { kind: "markers"; items: number[]; t: number; y: number }
    | { kind: "span"; span: number; y: number };

interface DragState {
    mode: "pan" | "box";
    startX: number;
    startView: TsRange;
    moved: boolean;
    currentX: number;
}

function Button({
    active,
    onClick,
    title,
    children,
    pressed,
}: {
    active?: boolean;
    onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void;
    title?: string;
    children: ReactNode;
    pressed?: boolean;
}) {
    return (
        <button
            type="button"
            title={title}
            aria-pressed={pressed}
            onClick={onClick}
            className={
                active
                    ? "rounded-card border border-accent/50 bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent"
                    : "rounded-card border border-line px-2 py-0.5 text-xs text-dim transition-colors hover:bg-panel hover:text-ink"
            }
        >
            {children}
        </button>
    );
}

function Swatch({ color, dashed, glyph }: { color: string; dashed?: boolean; glyph?: Glyph }) {
    if (glyph) {
        const shape =
            glyph === "circle"
                ? "rounded-full"
                : glyph === "diamond"
                  ? "rotate-45 rounded-[1px]"
                  : glyph === "triangle"
                    ? "[clip-path:polygon(50%_0,100%_100%,0_100%)]"
                    : "rounded-[1px]";

        return <span className={`inline-block h-2 w-2 shrink-0 ${shape}`} style={{ background: color }} />;
    }

    return (
        <span
            className="inline-block w-3 shrink-0"
            style={{ borderTop: `2px ${dashed ? "dashed" : "solid"} ${color}`, height: 0 }}
        />
    );
}

export function TimeSeries({
    id,
    title,
    series,
    markers = NO_MARKERS,
    spans = NO_SPANS,
    range,
    layout: initialLayout = "combined",
    height,
    timeZone = "Europe/Prague",
    syncId,
    units,
    lanesHeight = 220,
    brush = true,
}: TimeSeriesProps) {
    const instanceId = useId();
    const rootRef = useRef<HTMLDivElement>(null);
    const plotRef = useRef<HTMLDivElement>(null);
    const mainRef = useRef<HTMLCanvasElement>(null);
    const overlayRef = useRef<HTMLCanvasElement>(null);
    const brushRef = useRef<HTMLCanvasElement>(null);
    const [width, setWidth] = useState(0);
    const [themeTick, setThemeTick] = useState(0);
    const [saved, setSaved] = useState<TsViewState>(() => loadViewState(id));
    const bounds = useMemo(() => boundsOf(series, markers, spans), [series, markers, spans]);
    const [view, setViewState] = useState<TsRange>(() =>
        clampRange(saved.range ?? range ?? bounds, { bounds, minSpan: MIN_SPAN })
    );
    const [hover, setHover] = useState<Hover | null>(null);
    const [remoteHover, setRemoteHover] = useState<number | null>(null);
    const [pin, setPin] = useState<Pin | null>(null);
    const [boxMode, setBoxMode] = useState(false);
    const [drag, setDrag] = useState<DragState | null>(null);
    const [copied, setCopied] = useState(false);

    const layout = saved.layout ?? initialLayout;
    const logUnits = useMemo(() => {
        const set = new Set(saved.log);

        for (const [unit, cfg] of Object.entries(units ?? {})) {
            if (cfg.log && !saved.log.includes(`!${unit}`)) {
                set.add(unit);
            }
        }

        for (const entry of saved.log) {
            if (entry.startsWith("!")) {
                set.delete(entry.slice(1));
            }
        }

        return set;
    }, [saved.log, units]);

    const visibleIds = useMemo(
        () => new Set(series.filter((s) => saved.series[s.id] ?? !s.hidden).map((s) => s.id)),
        [series, saved.series]
    );
    const hiddenMarkerKinds = useMemo(() => new Set(saved.hiddenMarkers), [saved.hiddenMarkers]);
    const hiddenLanes = useMemo(() => new Set(saved.hiddenLanes), [saved.hiddenLanes]);

    const update = useCallback((patch: (s: TsViewState) => TsViewState) => setSaved((prev) => patch(prev)), []);

    // Keep the view inside new bounds when the data changes.
    useEffect(() => {
        setViewState((v) => {
            const next = clampRange(v, { bounds, minSpan: MIN_SPAN });

            return next[0] === v[0] && next[1] === v[1] ? v : next;
        });
    }, [bounds]);

    const setView = useCallback(
        (next: TsRange, publish = true) => {
            const clamped = clampRange(next, { bounds, minSpan: MIN_SPAN });
            setViewState(clamped);

            if (publish && syncId) {
                syncPublish(syncId, { from: instanceId, range: clamped });
            }
        },
        [bounds, syncId, instanceId]
    );

    // Persist the viewer's choices (debounced; the view moves at frame rate while zooming).
    useEffect(() => {
        if (!id) {
            return;
        }

        const timer = window.setTimeout(() => {
            const full = view[0] <= bounds[0] && view[1] >= bounds[1];
            saveViewState(id, { ...saved, range: full ? undefined : view });
        }, 300);

        return () => window.clearTimeout(timer);
    }, [id, saved, view, bounds]);

    useEffect(() => {
        if (!syncId) {
            return;
        }

        return syncSubscribe(syncId, (m) => {
            if (m.from === instanceId) {
                return;
            }

            if (m.range) {
                setViewState(clampRange(m.range, { bounds, minSpan: MIN_SPAN }));
            }

            if (m.hover !== undefined) {
                setRemoteHover(m.hover);
            }
        });
    }, [syncId, instanceId, bounds]);

    // Width tracking.
    useEffect(() => {
        const el = plotRef.current;

        if (!el) {
            return;
        }

        setWidth(el.clientWidth);

        if (typeof ResizeObserver === "undefined") {
            return;
        }

        const ro = new ResizeObserver((entries) => {
            const w = entries[0]?.contentRect.width;

            if (w !== undefined) {
                setWidth(Math.floor(w));
            }
        });
        ro.observe(el);

        return () => ro.disconnect();
    }, []);

    // Theme changes: a color-scheme flip or a swapped stylesheet redraws with the new tokens.
    useEffect(() => {
        const bump = () => setThemeTick((n) => n + 1);
        const media =
            typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
        media?.addEventListener?.("change", bump);
        let mo: MutationObserver | null = null;

        if (typeof MutationObserver !== "undefined") {
            mo = new MutationObserver(bump);
            mo.observe(document.documentElement, {
                attributes: true,
                attributeFilter: ["class", "style", "data-theme"],
            });
            mo.observe(document.head, { childList: true });
        }

        return () => {
            media?.removeEventListener?.("change", bump);
            mo?.disconnect();
        };
    }, []);

    // ─── Colors per series / marker kind / span kind ───

    const seriesColor = useMemo(() => new Map(series.map((s, i) => [s.id, cssColor(s, i)])), [series]);
    const markerKinds = useMemo(() => [...new Set(markers.map((m) => m.kind))], [markers]);
    const markerKindColor = useMemo(() => {
        const map = new Map<string, string>();

        for (const [i, kind] of markerKinds.entries()) {
            const sample = markers.find((m) => m.kind === kind && (m.color || m.tone));
            map.set(kind, sample ? cssColor(sample, 0) : paletteColor((i + 3) % 8));
        }

        return map;
    }, [markers, markerKinds]);
    const markerColor = useCallback(
        (m: TsMarker) => m.color ?? (m.tone ? TONE_COLOR[m.tone] : (markerKindColor.get(m.kind) ?? "var(--dim)")),
        [markerKindColor]
    );
    const markerGlyph = useCallback(
        (kind: string): Glyph => GLYPHS[Math.max(0, markerKinds.indexOf(kind)) % GLYPHS.length],
        [markerKinds]
    );
    const spanKinds = useMemo(() => [...new Set(spans.map((s) => s.kind))], [spans]);
    const spanColor = useCallback(
        (s: TsSpan) => s.color ?? (s.tone ? TONE_COLOR[s.tone] : paletteColor(spanKinds.indexOf(s.kind) % 11)),
        [spanKinds]
    );

    const sortedMarkerIdx = useMemo(
        () => markers.map((_, i) => i).sort((a, b) => markers[a].t - markers[b].t),
        [markers]
    );
    const laneLayout = useMemo(() => layoutLanes(spans), [spans]);
    const laneOrder = useMemo(() => laneLayout.map((l) => l.name), [laneLayout]);
    // Brush gesture start view; the pointer drag keeps its own in `drag`.
    const [brushGesture, setBrushGesture] = useState<TsRange | null>(null);
    const gutterLeft = useMemo(
        () =>
            spans.length && saved.lanesOpen
                ? laneGutterWidth(
                      laneOrder.filter((n) => !hiddenLanes.has(n)),
                      GUTTER_MIN
                  )
                : GUTTER_MIN,
        [spans.length, saved.lanesOpen, laneOrder, hiddenLanes]
    );
    // Rows are packed from the spans in view. During a pan gesture the packing window is frozen to the
    // gesture's start view widened by one view on each side, so rows do not reshuffle under the pointer.
    const gestureView = drag?.mode === "pan" ? drag.startView : brushGesture;
    const packRange = useMemo<TsRange>(() => {
        if (!gestureView) {
            return view;
        }

        const w = gestureView[1] - gestureView[0];

        return [gestureView[0] - w, gestureView[1] + w];
    }, [gestureView, view]);
    const visibleLanes = useMemo(() => layoutLanesIn(spans, packRange, laneOrder), [spans, packRange, laneOrder]);

    // Stacked sources, recomputed when the visible set changes so a hidden layer drops out of the stack.
    const sources = useMemo(() => {
        const map = new Map<string, { src: readonly TsPoint[]; base: readonly TsPoint[] | null; stacked: boolean }>();
        const stacks = new Map<string, TsSeries[]>();

        for (const s of series) {
            if (!visibleIds.has(s.id)) {
                continue;
            }

            if (s.stack && (s.kind === "area" || s.kind === "bar")) {
                const list = stacks.get(s.stack) ?? [];
                list.push(s);
                stacks.set(s.stack, list);
            } else {
                map.set(s.id, { src: s.points, base: null, stacked: false });
            }
        }

        for (const members of stacks.values()) {
            const stacked = stackPoints(members.map((m) => m.points));

            for (const [i, m] of members.entries()) {
                const many = members.length > 1;
                map.set(m.id, { src: stacked[i].top, base: many ? stacked[i].base : null, stacked: many });
            }
        }

        return map;
    }, [series, visibleIds]);

    // ─── Frame ───

    const frame = useMemo<Frame | null>(() => {
        if (width <= 0) {
            return null;
        }

        const visible = series.filter((s) => visibleIds.has(s.id));
        const normalize = saved.normalize;
        const unitOf = (s: TsSeries) => (normalize ? "% of max" : (s.unit ?? NO_UNIT));
        const specs = assignPanels(
            visible.map((s) => ({ id: s.id, unit: unitOf(s), group: s.group ?? s.unit ?? NO_UNIT })),
            layout
        );
        const hasRight = specs.some((p) => p.axes.length > 1);
        const plotLeft = gutterLeft;
        const plotRight = width - (hasRight ? GUTTER_RIGHT_AXIS : GUTTER_RIGHT);
        const plotWidth = Math.max(10, plotRight - plotLeft);
        const visibleMarkers = sortedMarkerIdx.filter((i) => !hiddenMarkerKinds.has(markers[i].kind));
        const markerHeight = markers.length ? MARKER_BAND : 0;
        const panelHeight = height ?? (specs.length <= 1 ? 300 : 170);
        const byId = new Map(series.map((s, i) => [s.id, { s, i }]));
        let y = markerHeight;
        const panels: PanelFrame[] = [];

        for (const spec of specs.length ? specs : [{ key: "empty", axes: [], seriesIds: [] }]) {
            const panel: PanelFrame = { key: spec.key, top: y, height: panelHeight, axes: [], series: [] };

            for (const ax of spec.axes) {
                const cfg = units?.[ax.unit];
                const log = logUnits.has(ax.unit) && !normalize;
                const members: Array<Omit<SeriesFrame, "axis">> = [];
                let lo = Number.POSITIVE_INFINITY;
                let hi = Number.NEGATIVE_INFINITY;
                let wantsZero = false;

                for (const sid of ax.seriesIds) {
                    const entry = byId.get(sid);
                    const source = sources.get(sid);

                    if (!entry || !source) {
                        continue;
                    }

                    const kind = entry.s.kind ?? "line";
                    let pts = decimate(source.src, view[0], view[1], plotWidth);
                    let scale = 1;

                    if (normalize) {
                        const ext = extentIn(source.src, view[0], view[1]);
                        scale = Math.max(Math.abs(ext?.[0] ?? 0), Math.abs(ext?.[1] ?? 0)) / 100 || 1;
                        pts = pts.map(([t, v]) => [t, v === null ? null : v / scale]);
                    }

                    const ext = extentIn(pts, view[0], view[1]) ?? extentIn(pts, -Infinity, Infinity);

                    if (ext) {
                        lo = Math.min(lo, ext[0]);
                        hi = Math.max(hi, ext[1]);
                    }

                    wantsZero ||= kind === "area" || kind === "bar";
                    members.push({
                        s: entry.s,
                        index: entry.i,
                        color: seriesColor.get(sid) ?? paletteColor(entry.i),
                        kind,
                        src: source.src,
                        base: source.base,
                        pts,
                        scale,
                        stacked: source.stacked,
                    });
                }

                if (!Number.isFinite(lo)) {
                    lo = 0;
                    hi = 1;
                }

                let scaleSpec: { min: number; max: number; ticks: number[] };

                if (log) {
                    let minPos = Number.POSITIVE_INFINITY;

                    for (const m of members) {
                        for (const [, v] of m.pts) {
                            if (v !== null && v > 0 && v < minPos) {
                                minPos = v;
                            }
                        }
                    }

                    scaleSpec = logScale(Number.isFinite(minPos) ? minPos : 1, Math.max(hi, 1));
                } else {
                    if (lo >= 0 && (wantsZero || lo <= hi * 0.35)) {
                        lo = 0;
                    }

                    scaleSpec = niceScale(lo, hi, panelHeight < 200 ? 4 : 6);
                }

                const axis: AxisFrame = {
                    unit: ax.unit,
                    label: cfg?.label ?? ax.unit,
                    side: ax.side,
                    log,
                    ...scaleSpec,
                    format: normalize ? formatForUnit("%") : (cfg?.format ?? formatForUnit(ax.unit)),
                };
                panel.axes.push(axis);

                for (const m of members) {
                    panel.series.push({ ...m, axis });
                }
            }

            panels.push(panel);
            y += panelHeight + PANEL_GAP;
        }

        const panelsBottom = y - PANEL_GAP;
        const axisTop = panelsBottom;
        const lanesTop = axisTop + TIME_AXIS;
        const lanes: LaneFrame[] = [];
        let lanesH = 0;

        if (spans.length && saved.lanesOpen) {
            const shown = visibleLanes.filter((l) => !hiddenLanes.has(l.name));
            const totalRows = shown.reduce((n, l) => n + l.rows, 0);
            const rowHeight = Math.max(
                4,
                Math.min(16, Math.floor((lanesHeight - shown.length * LANE_GAP) / Math.max(1, totalRows)) - 2)
            );
            let ly = lanesTop;

            for (const l of shown) {
                const h = l.rows * (rowHeight + 2);
                lanes.push({
                    name: l.name,
                    top: ly,
                    rowHeight,
                    rows: l.rows,
                    height: h,
                    items: l.items.map((index, k) => [index, l.itemRows[k]]),
                });
                ly += h + LANE_GAP;
            }

            lanesH = Math.max(0, ly - lanesTop - LANE_GAP);
        }

        const partial = { plotLeft, plotWidth, view };
        const xs = visibleMarkers.map((i) => toX(partial, markers[i].t));
        const inView = visibleMarkers
            .map((i, k) => ({ i, x: xs[k] }))
            .filter((m) => m.x >= plotLeft - 4 && m.x <= plotRight + 4);
        const clusters = clusterMarkers(
            inView.map((m) => m.x),
            14
        );

        return {
            width,
            gutterLeft,
            plotLeft,
            plotRight,
            plotWidth,
            view,
            markerTop: 0,
            markerHeight,
            panels,
            panelsTop: markerHeight,
            panelsBottom,
            axisTop,
            lanesTop,
            lanesHeight: lanesH,
            lanes,
            height: lanesTop + lanesH + (lanesH ? 4 : 0),
            ticks: timeTicks({ range: view, width: plotWidth, timeZone }),
            markerOrder: inView.map((m) => m.i),
            clusters,
        };
    }, [
        width,
        series,
        visibleIds,
        saved.normalize,
        saved.lanesOpen,
        layout,
        sortedMarkerIdx,
        hiddenMarkerKinds,
        markers,
        height,
        units,
        logUnits,
        sources,
        view,
        seriesColor,
        spans.length,
        visibleLanes,
        gutterLeft,
        hiddenLanes,
        lanesHeight,
        timeZone,
    ]);

    // ─── Draw ───

    useEffect(() => {
        const canvas = mainRef.current;
        const root = rootRef.current;

        if (!frame || !canvas || !root) {
            return;
        }

        void themeTick;
        const ctx = setupCanvas(canvas, frame.width, frame.height);

        if (ctx) {
            drawMain(ctx, { frame, theme: readTheme(root), markers, spans, markerColor, markerGlyph, spanColor });
        }
    }, [frame, themeTick, markers, spans, markerColor, markerGlyph, spanColor]);

    const crosshairT = hover?.region === "panel" ? hover.t : remoteHover;

    useEffect(() => {
        const canvas = overlayRef.current;
        const root = rootRef.current;

        if (!frame || !canvas || !root) {
            return;
        }

        void themeTick;
        const ctx = setupCanvas(canvas, frame.width, frame.height);

        if (!ctx) {
            return;
        }

        const theme = readTheme(root);
        const bottom = frame.lanesHeight ? frame.lanesTop + frame.lanesHeight : frame.panelsBottom;

        if (pin && pin.kind !== "span") {
            const x = Math.round(toX(frame, pin.t)) + 0.5;

            if (x >= frame.plotLeft && x <= frame.plotRight) {
                ctx.strokeStyle = theme.accent;
                ctx.setLineDash([4, 3]);
                ctx.beginPath();
                ctx.moveTo(x, frame.markerTop);
                ctx.lineTo(x, bottom);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        }

        if (crosshairT !== null && crosshairT >= frame.view[0] && crosshairT <= frame.view[1]) {
            const x = Math.round(toX(frame, crosshairT)) + 0.5;
            ctx.strokeStyle = theme.text;
            ctx.globalAlpha = 0.45;
            ctx.beginPath();
            ctx.moveTo(x, frame.markerTop);
            ctx.lineTo(x, bottom);
            ctx.stroke();
            ctx.globalAlpha = 1;
            const maxGap = ((frame.view[1] - frame.view[0]) / frame.plotWidth) * 40;

            for (const panel of frame.panels) {
                for (const sf of panel.series) {
                    let v: number | null = null;
                    let t = crosshairT;

                    if (sf.kind === "step") {
                        v = valueAt(sf.src, crosshairT);
                    } else {
                        const i = nearestIndex(sf.src, crosshairT, maxGap);

                        if (i >= 0) {
                            [t, v] = sf.src[i];
                        }
                    }

                    const yy = toY(panel, sf.axis, v === null ? null : v / sf.scale);

                    if (yy === null) {
                        continue;
                    }

                    ctx.fillStyle = theme.bg;
                    ctx.beginPath();
                    ctx.arc(toX(frame, t), yy, 4.5, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.fillStyle = theme.resolve(sf.color);
                    ctx.beginPath();
                    ctx.arc(toX(frame, t), yy, 3, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }

        if (drag?.mode === "box" && drag.moved) {
            const x0 = Math.max(frame.plotLeft, Math.min(drag.startX, drag.currentX));
            const x1 = Math.min(frame.plotRight, Math.max(drag.startX, drag.currentX));
            ctx.fillStyle = theme.accent;
            ctx.globalAlpha = 0.14;
            ctx.fillRect(x0, frame.panelsTop, x1 - x0, frame.panelsBottom - frame.panelsTop);
            ctx.globalAlpha = 0.8;
            ctx.strokeStyle = theme.accent;
            ctx.strokeRect(x0 + 0.5, frame.panelsTop + 0.5, x1 - x0 - 1, frame.panelsBottom - frame.panelsTop - 1);
            ctx.globalAlpha = 1;
        }
    }, [frame, crosshairT, pin, drag, themeTick]);

    // ─── Hit testing ───

    const hitTest = useCallback(
        (x: number, y: number): Hover => {
            if (!frame) {
                return { region: "none", x, y };
            }

            if (frame.markerHeight && y < frame.markerTop + frame.markerHeight) {
                let best = -1;
                let bestD = 10;

                for (const [i, c] of frame.clusters.entries()) {
                    const d = Math.abs(c.x - x);

                    if (d < bestD) {
                        best = i;
                        bestD = d;
                    }
                }

                return best >= 0 ? { region: "marker", x, y, cluster: best } : { region: "none", x, y };
            }

            if (frame.lanesHeight && y >= frame.lanesTop) {
                const t = toT(frame, x);
                const slack = ((frame.view[1] - frame.view[0]) / frame.plotWidth) * 2;

                for (const lane of frame.lanes) {
                    if (y < lane.top || y > lane.top + lane.height) {
                        continue;
                    }

                    const row = Math.floor((y - lane.top) / (lane.rowHeight + 2));

                    for (const [index, r] of lane.items) {
                        const sp = spans[index];

                        if (r === row && sp.start - slack <= t && sp.end + slack >= t) {
                            return { region: "span", x, y, span: index };
                        }
                    }
                }

                return { region: "none", x, y };
            }

            if (x >= frame.plotLeft && x <= frame.plotRight && y >= frame.panelsTop && y <= frame.axisTop + TIME_AXIS) {
                return { region: "panel", x, y, t: toT(frame, x) };
            }

            return { region: "none", x, y };
        },
        [frame, spans]
    );

    const localPoint = (e: { clientX: number; clientY: number }) => {
        const rect = plotRef.current?.getBoundingClientRect();

        return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
    };

    const publishHover = useCallback(
        (t: number | null) => {
            if (syncId) {
                syncPublish(syncId, { from: instanceId, hover: t });
            }
        },
        [syncId, instanceId]
    );

    const zoomBy = useCallback(
        (factor: number, anchor?: number) => {
            setView(zoomRange(view, { factor, anchor, bounds, minSpan: MIN_SPAN }));
        },
        [view, bounds, setView]
    );

    const reset = useCallback(() => setView(bounds), [bounds, setView]);

    // Wheel needs a non-passive listener to keep the page from scrolling while zooming.
    useEffect(() => {
        const el = plotRef.current;

        if (!el || !frame) {
            return;
        }

        const onWheel = (e: WheelEvent) => {
            const { x } = localPoint(e);

            if (x < frame.plotLeft - 4 || x > frame.plotRight + 4) {
                return;
            }

            e.preventDefault();
            const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
            const dx = e.deltaX * unit;
            const dy = e.deltaY * unit;

            if (Math.abs(dx) > Math.abs(dy) && !e.ctrlKey) {
                setView(panRange(view, (dx / frame.plotWidth) * (view[1] - view[0]), bounds));

                return;
            }

            // One mouse notch reports 100 to 240 px; cap it so a notch is a step, not a jump.
            const capped = Math.max(-200, Math.min(200, dy));
            const factor = Math.exp(capped * (e.ctrlKey ? 0.01 : 0.0014));
            setView(zoomRange(view, { factor, anchor: toT(frame, x), bounds, minSpan: MIN_SPAN }));
        };
        el.addEventListener("wheel", onWheel, { passive: false });

        return () => el.removeEventListener("wheel", onWheel);
    }, [frame, view, bounds, setView]);

    const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (e.button !== 0 || !frame) {
            return;
        }

        const { x } = localPoint(e);
        e.currentTarget.setPointerCapture?.(e.pointerId);
        setDrag({ mode: e.shiftKey || boxMode ? "box" : "pan", startX: x, startView: view, moved: false, currentX: x });
    };

    const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        const { x, y } = localPoint(e);

        if (drag && frame) {
            const moved = drag.moved || Math.abs(x - drag.startX) > 3;

            if (drag.mode === "pan" && moved) {
                const span = drag.startView[1] - drag.startView[0];
                setView(panRange(drag.startView, (-(x - drag.startX) / frame.plotWidth) * span, bounds));
            }

            setDrag({ ...drag, moved, currentX: x });

            if (moved) {
                return;
            }
        }

        const h = hitTest(x, y);
        setHover(h);
        publishHover(h.region === "panel" ? h.t : null);
    };

    const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
        const current = drag;
        setDrag(null);

        if (!current || !frame) {
            return;
        }

        const { x, y } = localPoint(e);

        if (current.mode === "box" && current.moved) {
            const a = toT(frame, Math.max(frame.plotLeft, Math.min(current.startX, x)));
            const b = toT(frame, Math.min(frame.plotRight, Math.max(current.startX, x)));

            if (b - a > MIN_SPAN / 2) {
                setView([a, b]);
            }

            return;
        }

        if (current.moved) {
            return;
        }

        const h = hitTest(x, y);

        if (h.region === "panel") {
            setPin(pin?.kind === "time" && Math.abs(toX(frame, pin.t) - x) < 4 ? null : { kind: "time", t: h.t, y });
        } else if (h.region === "marker") {
            const items = frame.clusters[h.cluster].items.map((k) => frame.markerOrder[k]);
            setPin({ kind: "markers", items, t: markers[items[0]].t, y });
        } else if (h.region === "span") {
            setPin({ kind: "span", span: h.span, y });
        } else {
            setPin(null);
        }
    };

    const onLeave = () => {
        if (!drag) {
            setHover(null);
            publishHover(null);
        }
    };

    const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
        const span = view[1] - view[0];
        const handled: Record<string, () => void> = {
            "+": () => zoomBy(0.7),
            "=": () => zoomBy(0.7),
            "-": () => zoomBy(1 / 0.7),
            _: () => zoomBy(1 / 0.7),
            ArrowLeft: () => setView(panRange(view, -span * (e.shiftKey ? 0.5 : 0.1), bounds)),
            ArrowRight: () => setView(panRange(view, span * (e.shiftKey ? 0.5 : 0.1), bounds)),
            ArrowUp: () => zoomBy(0.7),
            ArrowDown: () => zoomBy(1 / 0.7),
            "0": reset,
            Home: () => setView(rangeAround(bounds[0] + span / 2, span, bounds)),
            End: () => setView(rangeAround(bounds[1] - span / 2, span, bounds)),
            Escape: () => setPin(null),
        };
        const action = handled[e.key];

        if (action && e.target === e.currentTarget) {
            e.preventDefault();
            action();
        }
    };

    // ─── Toolbar actions ───

    const toggleSeries = (s: TsSeries, solo: boolean) => {
        update((prev) => {
            const next = { ...prev.series };

            if (solo) {
                const alreadySolo = visibleIds.size === 1 && visibleIds.has(s.id);

                for (const other of series) {
                    next[other.id] = alreadySolo ? !other.hidden : other.id === s.id;
                }
            } else {
                next[s.id] = !visibleIds.has(s.id);
            }

            for (const other of series) {
                if (next[other.id] === !other.hidden) {
                    delete next[other.id];
                }
            }

            return { ...prev, series: next };
        });
    };

    const toggleIn = (list: string[], item: string) =>
        list.includes(item) ? list.filter((x) => x !== item) : [...list, item];

    const toggleLog = (unit: string) => {
        update((prev) => {
            const defaultOn = Boolean(units?.[unit]?.log);
            const isOn = logUnits.has(unit);
            const rest = prev.log.filter((x) => x !== unit && x !== `!${unit}`);

            if (isOn === defaultOn) {
                return { ...prev, log: [...rest, defaultOn ? `!${unit}` : unit] };
            }

            return { ...prev, log: rest };
        });
    };

    const visibleSeries = series.filter((s) => visibleIds.has(s.id));
    const visibleUnits = [...new Set(visibleSeries.map((s) => s.unit ?? NO_UNIT))];

    const download = (name: string, href: string) => {
        const a = document.createElement("a");
        a.href = href;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
    };

    const fileBase = (id ?? title ?? "timeseries").replace(/[^\w.-]+/g, "-");

    const exportCsv = () => {
        const csv = toCsv(
            visibleSeries.map((s) => ({ label: s.unit ? `${s.label} (${s.unit})` : s.label, points: s.points })),
            view
        );
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
        download(`${fileBase}.csv`, url);
        window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    };

    const exportPng = () => {
        const canvas = mainRef.current;
        const root = rootRef.current;

        if (!frame || !canvas || !root) {
            return;
        }

        const theme = readTheme(root);
        const dpr = window.devicePixelRatio || 1;
        const head = 50;
        const out = document.createElement("canvas");
        out.width = Math.round(frame.width * dpr);
        out.height = Math.round((frame.height + head) * dpr);
        const ctx = out.getContext("2d");

        if (!ctx) {
            return;
        }

        ctx.scale(dpr, dpr);
        ctx.fillStyle = theme.bg;
        ctx.fillRect(0, 0, frame.width, frame.height + head);
        ctx.fillStyle = theme.text;
        ctx.font = `600 13px ${theme.font}`;
        ctx.textBaseline = "middle";
        ctx.fillText(
            `${title ?? "Time series"}  ${formatTime(view[0], timeZone, "full")} to ${formatTime(view[1], timeZone, "full")}`,
            8,
            15
        );
        // Legend with the chip state: series that are off are drawn faded and struck through.
        ctx.font = `11px ${theme.font}`;
        let lx = 8;

        for (const s of series) {
            const on = visibleIds.has(s.id);
            const label = s.unit ? `${s.label} (${units?.[s.unit]?.label ?? s.unit})` : s.label;
            const w = ctx.measureText(label).width;
            ctx.globalAlpha = on ? 1 : 0.4;
            ctx.strokeStyle = theme.resolve(seriesColor.get(s.id) ?? "var(--dim)");
            ctx.lineWidth = 2;
            ctx.setLineDash(s.dashed ? [3, 2] : []);
            ctx.beginPath();
            ctx.moveTo(lx, 37);
            ctx.lineTo(lx + 12, 37);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = on ? theme.text : theme.dim;
            ctx.textAlign = "left";
            ctx.fillText(label, lx + 16, 37);

            if (!on) {
                ctx.fillRect(lx + 16, 37, w, 1);
            }

            lx += w + 34;
        }

        ctx.globalAlpha = 1;
        ctx.drawImage(canvas, 0, head, frame.width, frame.height);
        ctx.font = `10px ${theme.font}`;
        ctx.fillStyle = theme.dim;
        ctx.textAlign = "right";

        for (const lane of frame.lanes) {
            ctx.fillText(lane.name, frame.plotLeft - 8, lane.top + Math.min(lane.height, 16) / 2 + head);
        }

        for (const panel of frame.panels) {
            for (const axis of panel.axes) {
                ctx.textAlign = axis.side === "left" ? "right" : "left";
                const x = axis.side === "left" ? frame.plotLeft - 6 : frame.plotRight + 6;

                for (const v of axis.ticks) {
                    const yy = toY(panel, axis, v);

                    if (yy !== null && yy >= panel.top && yy <= panel.top + panel.height) {
                        ctx.fillText(axis.format(v), x, yy + head);
                    }
                }
            }
        }

        ctx.textAlign = "center";

        for (const tick of frame.ticks) {
            ctx.fillText(tick.label, toX(frame, tick.t), frame.axisTop + 12 + head);
        }

        download(`${fileBase}.png`, out.toDataURL("image/png"));
    };

    const copyLink = async () => {
        if (!id) {
            return;
        }

        const full = view[0] <= bounds[0] && view[1] >= bounds[1];
        const encoded = encodeViewState({ ...saved, range: full ? undefined : view });
        const hash = writeHashState(window.location.hash, id, encoded);
        const url = `${window.location.origin}${window.location.pathname}${window.location.search}${hash}`;

        try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
        } catch {
            window.prompt("Copy this link", url);
        }
    };

    // ─── Tooltip content ───

    const msPerPx = frame ? (frame.view[1] - frame.view[0]) / frame.plotWidth : 0;

    const seriesRows = (t: number) =>
        (frame?.panels ?? []).flatMap((panel) =>
            panel.series.map((sf) => {
                const s = sf.s;
                let v: number | null = null;

                if (sf.kind === "step") {
                    v = valueAt(s.points, t);
                } else {
                    const i = nearestIndex(s.points, t, msPerPx * 40);
                    v = i >= 0 ? s.points[i][1] : null;
                }

                const fmt = units?.[s.unit ?? ""]?.format ?? formatForUnit(s.unit);

                return { s, color: sf.color, v, text: v === null ? "no data" : fmt(v) };
            })
        );

    const nearestMarker = (t: number) => {
        let best: number | null = null;
        let bestD = msPerPx * 30;

        for (const i of frame?.markerOrder ?? []) {
            const d = Math.abs(markers[i].t - t);

            if (d <= bestD) {
                best = i;
                bestD = d;
            }
        }

        return best;
    };

    const markerList = (items: number[], interactive: boolean) => {
        const shown = items.slice(0, 10);

        return (
            <div className="space-y-1">
                {shown.map((i) => {
                    const m = markers[i];

                    return (
                        <div key={i}>
                            <div className="flex items-baseline gap-2">
                                <Swatch color={markerColor(m)} glyph={markerGlyph(m.kind)} />
                                <span className="font-mono text-[0.7rem] text-dim">
                                    {formatTime(m.t, timeZone, "seconds")}
                                </span>
                                <span className="text-ink">{m.label}</span>
                                <span className="text-[0.7rem] text-dim">{m.kind}</span>
                            </div>
                            {m.detail && (items.length === 1 || interactive) ? (
                                <Md className="mt-0.5 pl-4 text-xs! text-dim">{m.detail}</Md>
                            ) : null}
                        </div>
                    );
                })}
                {items.length > shown.length ? (
                    <div className="text-xs text-dim">and {items.length - shown.length} more</div>
                ) : null}
            </div>
        );
    };

    const spanBody = (index: number) => {
        const sp = spans[index];

        return (
            <div>
                <div className="flex items-baseline gap-2">
                    <Swatch color={spanColor(sp)} glyph="square" />
                    <span className="font-medium text-ink">{sp.label}</span>
                </div>
                <div className="mt-0.5 text-xs text-dim">
                    {sp.kind}
                    {sp.lane ? ` in ${sp.lane}` : ""} · {formatDurationShort(sp.end - sp.start)}
                </div>
                <div className="font-mono text-[0.7rem] text-dim">
                    {formatTime(sp.start, timeZone, "full")} to {formatTime(sp.end, timeZone, "seconds")}
                </div>
                {sp.detail ? <Md className="mt-1 text-xs! text-dim">{sp.detail}</Md> : null}
            </div>
        );
    };

    const timeBody = (t: number) => {
        const rows = seriesRows(t);
        const pinT = pin?.kind === "time" && hover?.region === "panel" ? pin.t : null;
        const pinRows = pinT !== null ? seriesRows(pinT) : null;
        const mi = nearestMarker(t);

        return (
            <div>
                <div className="mb-1 flex items-baseline justify-between gap-3">
                    <span className="font-mono text-[0.72rem] text-ink">{formatTime(t, timeZone, "full")}</span>
                    {pinT !== null && Math.abs(pinT - t) > msPerPx ? (
                        <span className="font-mono text-[0.7rem] text-accent">
                            {formatDurationShort(t - pinT)} from pin
                        </span>
                    ) : null}
                </div>
                <table className="w-full text-xs">
                    <tbody>
                        {rows.map((r, k) => {
                            const before = pinRows?.[k]?.v;
                            const delta = r.v !== null && before != null && pinT !== null ? r.v - before : null;
                            const fmt = units?.[r.s.unit ?? ""]?.format ?? formatForUnit(r.s.unit);

                            return (
                                <tr key={r.s.id}>
                                    <td className="py-px pr-2">
                                        <span className="inline-flex items-center gap-1.5">
                                            <Swatch color={r.color} dashed={r.s.dashed} />
                                            <span className="text-dim">{r.s.label}</span>
                                        </span>
                                    </td>
                                    <td className="py-px text-right font-mono text-ink">{r.text}</td>
                                    {pinRows ? (
                                        <td className="py-px pl-2 text-right font-mono text-[0.7rem] text-accent">
                                            {delta === null || delta === 0
                                                ? ""
                                                : `${delta > 0 ? "+" : "-"}${fmt(Math.abs(delta))}`}
                                        </td>
                                    ) : null}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
                {mi !== null ? (
                    <div className="mt-1 border-t border-line pt-1 text-xs">{markerList([mi], false)}</div>
                ) : null}
            </div>
        );
    };

    const tooltipBox = (x: number, y: number, body: ReactNode, interactive: boolean, actions?: ReactNode) => {
        const left = x > width - 300 ? Math.max(4, x - 296) : x + 14;

        return (
            <div
                className={`absolute z-10 w-max max-w-[280px] rounded-card border border-line bg-panel px-3 py-2 text-xs shadow-lg ${interactive ? "" : "pointer-events-none"}`}
                style={{ left, top: Math.max(4, y + 12) }}
                role={interactive ? "dialog" : "tooltip"}
            >
                {body}
                {interactive ? (
                    <div className="mt-2 flex flex-wrap gap-1.5 border-t border-line pt-1.5">
                        {actions}
                        <Button onClick={() => setPin(null)} title="Close (Esc)">
                            Unpin
                        </Button>
                    </div>
                ) : null}
            </div>
        );
    };

    let pinnedTip: ReactNode = null;

    if (pin && frame) {
        if (pin.kind === "time") {
            const x = toX(frame, pin.t);

            if (x >= frame.plotLeft - 2 && x <= frame.plotRight + 2) {
                pinnedTip = tooltipBox(
                    x,
                    pin.y,
                    timeBody(pin.t),
                    true,
                    <Button onClick={() => setView(rangeAround(pin.t, (view[1] - view[0]) / 4, bounds))}>
                        Zoom here
                    </Button>
                );
            }
        } else if (pin.kind === "markers") {
            const ts = pin.items.map((i) => markers[i].t);
            const lo = Math.min(...ts);
            const hi = Math.max(...ts);
            pinnedTip = tooltipBox(
                toX(frame, pin.t),
                pin.y,
                markerList(pin.items, true),
                true,
                pin.items.length > 1 ? (
                    <Button onClick={() => setView([lo - (hi - lo) * 0.15 - MINUTE, hi + (hi - lo) * 0.15 + MINUTE])}>
                        Zoom to these
                    </Button>
                ) : (
                    <Button onClick={() => setView(rangeAround(pin.t, (view[1] - view[0]) / 6, bounds))}>
                        Zoom here
                    </Button>
                )
            );
        } else {
            const sp = spans[pin.span];
            const pad = (sp.end - sp.start) * 0.1 + SECOND;
            pinnedTip = tooltipBox(
                Math.min(Math.max(toX(frame, sp.start), frame.plotLeft), frame.plotRight),
                pin.y,
                spanBody(pin.span),
                true,
                <Button onClick={() => setView([sp.start - pad, sp.end + pad])}>Zoom to span</Button>
            );
        }
    }

    let hoverTip: ReactNode = null;

    if (hover && frame && !drag) {
        if (hover.region === "panel" && !(pin?.kind === "time" && Math.abs(toX(frame, pin.t) - hover.x) < 3)) {
            hoverTip = tooltipBox(hover.x, hover.y, timeBody(hover.t), false);
        } else if (hover.region === "marker") {
            hoverTip = tooltipBox(
                hover.x,
                hover.y,
                markerList(
                    frame.clusters[hover.cluster].items.map((k) => frame.markerOrder[k]),
                    false
                ),
                false
            );
        } else if (hover.region === "span" && !(pin?.kind === "span" && pin.span === hover.span)) {
            hoverTip = tooltipBox(hover.x, hover.y, spanBody(hover.span), false);
        }
    }

    // ─── Brush ───

    const overview = useMemo(() => {
        if (!brush || width <= 0) {
            return null;
        }

        const plotWidth = Math.max(10, (frame?.plotRight ?? width - GUTTER_RIGHT) - gutterLeft);

        return series
            .filter((s) => visibleIds.has(s.id))
            .map((s, i) => {
                const pts = decimate(s.points, bounds[0], bounds[1], plotWidth);
                const ext = extentIn(pts, -Infinity, Infinity) ?? [0, 1];

                return { color: seriesColor.get(s.id) ?? paletteColor(i), pts, ext, plotWidth };
            });
    }, [brush, width, frame?.plotRight, series, visibleIds, bounds, seriesColor]);

    useEffect(() => {
        const canvas = brushRef.current;
        const root = rootRef.current;

        if (!overview || !canvas || !root || width <= 0) {
            return;
        }

        void themeTick;
        const ctx = setupCanvas(canvas, width, BRUSH_HEIGHT);

        if (!ctx) {
            return;
        }

        const theme = readTheme(root);
        const plotWidth = overview[0]?.plotWidth ?? width - gutterLeft - GUTTER_RIGHT;
        const bx = (t: number) => gutterLeft + ((t - bounds[0]) / (bounds[1] - bounds[0])) * plotWidth;
        ctx.fillStyle = theme.panel;
        ctx.fillRect(gutterLeft, 0, plotWidth, BRUSH_HEIGHT);

        for (const o of overview) {
            const [lo, hi] = o.ext;
            ctx.strokeStyle = theme.resolve(o.color);
            ctx.globalAlpha = 0.75;
            ctx.lineWidth = 1;
            ctx.beginPath();
            let pen = false;

            for (const [t, v] of o.pts) {
                if (v === null) {
                    pen = false;

                    continue;
                }

                const yy = BRUSH_HEIGHT - 4 - ((v - lo) / (hi - lo || 1)) * (BRUSH_HEIGHT - 10);

                if (pen) {
                    ctx.lineTo(bx(t), yy);
                } else {
                    ctx.moveTo(bx(t), yy);
                    pen = true;
                }
            }

            ctx.stroke();
        }

        ctx.globalAlpha = 0.7;

        for (const m of markers) {
            if (hiddenMarkerKinds.has(m.kind)) {
                continue;
            }

            ctx.fillStyle = theme.resolve(markerColor(m));
            ctx.fillRect(Math.round(bx(m.t)), 0, 1, 4);
        }

        ctx.globalAlpha = 1;
    }, [overview, width, bounds, themeTick, markers, markerColor, hiddenMarkerKinds]);

    const brushDrag = useRef<{ mode: "move" | "left" | "right"; startX: number; startView: TsRange } | null>(null);
    const brushPlotWidth = overview?.[0]?.plotWidth ?? Math.max(10, width - gutterLeft - GUTTER_RIGHT);
    const brushX = (t: number) => gutterLeft + ((t - bounds[0]) / (bounds[1] - bounds[0])) * brushPlotWidth;
    const brushT = (x: number) => bounds[0] + ((x - gutterLeft) / brushPlotWidth) * (bounds[1] - bounds[0]);

    const onBrushDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const wx0 = brushX(view[0]);
        const wx1 = brushX(view[1]);
        let mode: "move" | "left" | "right" = "move";
        let startView = view;

        if (Math.abs(x - wx0) < 7) {
            mode = "left";
        } else if (Math.abs(x - wx1) < 7) {
            mode = "right";
        } else if (x < wx0 || x > wx1) {
            startView = rangeAround(brushT(x), view[1] - view[0], bounds);
            setView(startView);
        }

        e.currentTarget.setPointerCapture?.(e.pointerId);
        brushDrag.current = { mode, startX: x, startView };

        if (mode === "move") {
            setBrushGesture(startView);
        }
    };

    const onBrushMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        const d = brushDrag.current;

        if (!d) {
            return;
        }

        const rect = e.currentTarget.getBoundingClientRect();
        const dt = ((e.clientX - rect.left - d.startX) / brushPlotWidth) * (bounds[1] - bounds[0]);

        if (d.mode === "move") {
            setView(panRange(d.startView, dt, bounds));
        } else if (d.mode === "left") {
            setView([Math.min(d.startView[0] + dt, d.startView[1] - MIN_SPAN), d.startView[1]]);
        } else {
            setView([d.startView[0], Math.max(d.startView[1] + dt, d.startView[0] + MIN_SPAN)]);
        }
    };

    // ─── Render ───

    const spanText = formatDurationShort(view[1] - view[0]);
    const isFull = view[0] <= bounds[0] && view[1] >= bounds[1];
    const activePreset = isFull
        ? "All"
        : PRESETS.find((p) => p.span !== null && Math.abs(p.span - (view[1] - view[0])) < p.span * 0.02)?.label;
    const unitsCount = new Set(visibleSeries.map((s) => s.unit ?? NO_UNIT)).size;
    const ariaSummary = `${title ?? "Time series"}: ${visibleSeries.length} of ${series.length} series (${visibleSeries
        .map((s) => s.label)
        .join(", ")}), ${formatTime(view[0], timeZone, "full")} to ${formatTime(view[1], timeZone, "full")}, ${
        markers.length
    } markers, ${spans.length} spans. Plus and minus zoom, arrow keys pan, 0 resets.`;

    return (
        <div
            ref={rootRef}
            role="group"
            tabIndex={0}
            aria-label={ariaSummary}
            onKeyDown={onKeyDown}
            className="my-4 rounded-card border border-line bg-panel/40 p-3 outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                {title ? <div className="text-sm font-semibold text-ink">{title}</div> : null}
                <div className="font-mono text-[0.72rem] text-dim" aria-live="polite">
                    {formatTime(view[0], timeZone, "full")} to {formatTime(view[1], timeZone, "full")} ({spanText})
                </div>
                <div className="ml-auto flex flex-wrap items-center gap-1">
                    {PRESETS.map((p) => (
                        <Button
                            key={p.label}
                            active={activePreset === p.label}
                            onClick={() =>
                                p.span === null
                                    ? reset()
                                    : setView(rangeAround((view[0] + view[1]) / 2, p.span, bounds))
                            }
                            title={p.span === null ? "Show all data (0)" : `Show ${p.label} around the center`}
                        >
                            {p.label}
                        </Button>
                    ))}
                    <span className="mx-1 h-4 w-px bg-line" />
                    <Button onClick={() => zoomBy(0.7)} title="Zoom in (+)">
                        +
                    </Button>
                    <Button onClick={() => zoomBy(1 / 0.7)} title="Zoom out (-)">
                        −
                    </Button>
                    <Button
                        active={boxMode}
                        pressed={boxMode}
                        onClick={() => setBoxMode((b) => !b)}
                        title="Drag selects a time range to zoom into (or hold Shift while dragging)"
                    >
                        Select
                    </Button>
                </div>
            </div>

            <div className="mb-2 flex flex-wrap items-center gap-1.5">
                {series.map((s) => {
                    const on = visibleIds.has(s.id);
                    const color = seriesColor.get(s.id) ?? "var(--dim)";

                    return (
                        <button
                            key={s.id}
                            type="button"
                            aria-pressed={on}
                            title="Click toggles, Alt-click shows only this series"
                            onClick={(e) => toggleSeries(s, e.altKey)}
                            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                                on ? "border-line bg-panel text-ink" : "border-dashed border-line text-dim opacity-60"
                            }`}
                        >
                            <Swatch color={color} dashed={s.dashed} />
                            {s.label}
                            {s.unit ? (
                                <span className="text-[0.65rem] text-dim">{units?.[s.unit]?.label ?? s.unit}</span>
                            ) : null}
                        </button>
                    );
                })}
            </div>

            <div className="mb-2 flex flex-wrap items-center gap-1">
                <div
                    role="radiogroup"
                    aria-label="Layout"
                    className="inline-flex overflow-hidden rounded-card border border-line"
                >
                    {(["combined", "split"] as const).map((l) => (
                        <button
                            key={l}
                            type="button"
                            role="radio"
                            aria-checked={layout === l}
                            onClick={() => update((prev) => ({ ...prev, layout: l }))}
                            className={
                                layout === l
                                    ? "bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent"
                                    : "px-2 py-0.5 text-xs text-dim hover:bg-panel hover:text-ink"
                            }
                        >
                            {l === "combined" ? "Combined" : "Split"}
                        </button>
                    ))}
                </div>
                <Button
                    active={saved.normalize}
                    pressed={saved.normalize}
                    onClick={() => update((prev) => ({ ...prev, normalize: !prev.normalize }))}
                    title="Scale every series to percent of its own maximum in view, so unlike units share one panel"
                >
                    % of max
                </Button>
                {!saved.normalize
                    ? visibleUnits.map((u) => (
                          <Button
                              key={u}
                              active={logUnits.has(u)}
                              pressed={logUnits.has(u)}
                              onClick={() => toggleLog(u)}
                              title={`Log scale for ${units?.[u]?.label ?? u}`}
                          >
                              log {units?.[u]?.label ?? u}
                          </Button>
                      ))
                    : null}
                {markerKinds.length ? <span className="mx-1 h-4 w-px bg-line" /> : null}
                {markerKinds.map((kind) => {
                    const on = !hiddenMarkerKinds.has(kind);
                    const count = markers.filter((m) => m.kind === kind).length;

                    return (
                        <Button
                            key={kind}
                            pressed={on}
                            active={false}
                            onClick={() =>
                                update((prev) => ({ ...prev, hiddenMarkers: toggleIn(prev.hiddenMarkers, kind) }))
                            }
                            title={`${on ? "Hide" : "Show"} ${kind} markers`}
                        >
                            <span className={`inline-flex items-center gap-1.5 ${on ? "" : "line-through opacity-50"}`}>
                                <Swatch color={markerKindColor.get(kind) ?? "var(--dim)"} glyph={markerGlyph(kind)} />
                                {kind} <span className="text-dim">{count}</span>
                            </span>
                        </Button>
                    );
                })}
                {spans.length ? <span className="mx-1 h-4 w-px bg-line" /> : null}
                {spans.length ? (
                    <Button
                        active={saved.lanesOpen}
                        pressed={saved.lanesOpen}
                        onClick={() => update((prev) => ({ ...prev, lanesOpen: !prev.lanesOpen }))}
                        title="Show or hide the span lanes"
                    >
                        Lanes {saved.lanesOpen ? "▾" : "▸"}
                    </Button>
                ) : null}
                {saved.lanesOpen
                    ? laneLayout.map((l) => {
                          const on = !hiddenLanes.has(l.name);

                          return (
                              <Button
                                  key={l.name}
                                  pressed={on}
                                  onClick={() =>
                                      update((prev) => ({ ...prev, hiddenLanes: toggleIn(prev.hiddenLanes, l.name) }))
                                  }
                                  title={`${on ? "Hide" : "Show"} the ${l.name} lane`}
                              >
                                  <span className={on ? "" : "line-through opacity-50"}>
                                      {l.name} <span className="text-dim">{l.items.length}</span>
                                  </span>
                              </Button>
                          );
                      })
                    : null}
                <div className="ml-auto flex flex-wrap items-center gap-1">
                    <Button
                        active={saved.table}
                        pressed={saved.table}
                        onClick={() => update((prev) => ({ ...prev, table: !prev.table }))}
                        title="Show the visible data as a table"
                    >
                        Table
                    </Button>
                    <Button onClick={exportCsv} title="Download the visible range as CSV">
                        CSV
                    </Button>
                    <Button onClick={exportPng} title="Download the chart as PNG">
                        PNG
                    </Button>
                    {id ? (
                        <Button onClick={() => void copyLink()} title="Copy a link that opens this exact view">
                            {copied ? "Copied" : "Link"}
                        </Button>
                    ) : null}
                </div>
            </div>
            {layout === "combined" && unitsCount > 2 && !saved.normalize ? (
                <div className="mb-1 text-[0.7rem] text-dim">
                    {unitsCount} units in view: one panel holds two axes, so the rest moved to extra panels. Use % of
                    max to overlay everything.
                </div>
            ) : null}

            <div
                ref={plotRef}
                className="relative w-full select-none"
                style={{ height: frame?.height ?? 300, touchAction: "none" }}
            >
                <canvas ref={mainRef} className="absolute inset-0" aria-hidden="true" />
                <canvas ref={overlayRef} className="pointer-events-none absolute inset-0" aria-hidden="true" />
                {frame ? <AxisLabels frame={frame} /> : null}
                {frame?.lanes.map((lane) => (
                    <div
                        key={lane.name}
                        className="absolute left-0 truncate pr-2 text-right text-[0.68rem] text-dim"
                        style={{
                            top: lane.top,
                            width: frame.gutterLeft,
                            lineHeight: `${Math.min(lane.height, 16)}px`,
                        }}
                        title={lane.name}
                    >
                        {lane.name}
                    </div>
                ))}
                {frame && visibleSeries.length === 0 ? (
                    <div className="absolute inset-x-0 top-1/3 text-center text-sm text-dim">
                        Every series is off. Click a chip above to show one.
                    </div>
                ) : null}
                <div
                    className={`absolute inset-0 ${drag?.mode === "pan" && drag.moved ? "cursor-grabbing" : boxMode ? "cursor-crosshair" : "cursor-default"}`}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerLeave={onLeave}
                    onDoubleClick={reset}
                />
                {hoverTip}
                {pinnedTip}
            </div>

            {brush ? (
                <div
                    className="relative mt-1 w-full cursor-pointer select-none"
                    style={{ height: BRUSH_HEIGHT, touchAction: "none" }}
                    onPointerDown={onBrushDown}
                    onPointerMove={onBrushMove}
                    onPointerUp={() => {
                        brushDrag.current = null;
                        setBrushGesture(null);
                    }}
                    aria-label="Overview: drag the window to move the view"
                >
                    <canvas ref={brushRef} className="absolute inset-0" aria-hidden="true" />
                    {width > 0 ? (
                        <>
                            <div
                                className="pointer-events-none absolute inset-y-0 bg-canvas/60"
                                style={{ left: gutterLeft, width: Math.max(0, brushX(view[0]) - gutterLeft) }}
                            />
                            <div
                                className="pointer-events-none absolute inset-y-0 bg-canvas/60"
                                style={{
                                    left: brushX(view[1]),
                                    width: Math.max(0, gutterLeft + brushPlotWidth - brushX(view[1])),
                                }}
                            />
                            <div
                                className="absolute inset-y-0 cursor-grab rounded-[3px] border border-accent/70 bg-accent/10"
                                style={{ left: brushX(view[0]), width: Math.max(3, brushX(view[1]) - brushX(view[0])) }}
                            >
                                <span className="absolute inset-y-2 -left-[3px] w-[5px] cursor-ew-resize rounded-sm bg-accent/80" />
                                <span className="absolute inset-y-2 -right-[3px] w-[5px] cursor-ew-resize rounded-sm bg-accent/80" />
                            </div>
                        </>
                    ) : null}
                </div>
            ) : null}

            <div className="mt-1 text-[0.68rem] text-dim">
                Wheel or pinch zooms, drag pans, Shift-drag selects, double-click resets, click pins the tooltip.
            </div>

            {saved.table ? <VisibleTable series={visibleSeries} view={view} timeZone={timeZone} units={units} /> : null}
        </div>
    );
}

function AxisLabels({ frame }: { frame: Frame }) {
    return (
        <>
            {frame.panels.map((panel) =>
                panel.axes.map((axis) => {
                    const left = axis.side === "left";

                    return (
                        <div key={`${panel.key}-${axis.unit}`} aria-hidden="true">
                            <div
                                className="pointer-events-none absolute max-w-[40%] truncate rounded-sm bg-canvas/70 px-1 text-[0.65rem] font-medium leading-4 text-dim"
                                style={
                                    left
                                        ? { top: panel.top + 2, left: frame.plotLeft + 4 }
                                        : { top: panel.top + 2, right: frame.width - frame.plotRight + 4 }
                                }
                            >
                                {axis.label}
                                {axis.log ? " (log)" : ""}
                            </div>
                            {axis.ticks.map((v) => {
                                const y = toY(panel, axis, v);

                                if (y === null || y < panel.top - 1 || y > panel.top + panel.height + 1) {
                                    return null;
                                }

                                return (
                                    <div
                                        key={v}
                                        className="absolute font-mono text-[0.65rem] leading-none text-dim"
                                        style={{
                                            top: y - 5,
                                            left: left ? 0 : frame.plotRight + 6,
                                            width: left ? frame.gutterLeft - 6 : GUTTER_RIGHT_AXIS - 6,
                                            textAlign: left ? "right" : "left",
                                        }}
                                    >
                                        {axis.format(v)}
                                    </div>
                                );
                            })}
                        </div>
                    );
                })
            )}
            {frame.ticks.map((tick) => {
                const x = toX(frame, tick.t);

                return (
                    <div
                        key={tick.t}
                        aria-hidden="true"
                        className={`absolute -translate-x-1/2 whitespace-nowrap font-mono text-[0.65rem] leading-none ${tick.major ? "font-semibold text-ink" : "text-dim"}`}
                        style={{ left: x, top: frame.axisTop + 7 }}
                    >
                        {tick.label}
                    </div>
                );
            })}
        </>
    );
}

const TABLE_LIMIT = 500;

function VisibleTable({
    series,
    view,
    timeZone,
    units,
}: {
    series: TsSeries[];
    view: TsRange;
    timeZone: string;
    units?: Record<string, TsUnitConfig>;
}) {
    const { rows, total } = useMemo(() => {
        const times = new Map<number, Array<number | null | undefined>>();

        for (const [col, s] of series.entries()) {
            for (const [t, v] of s.points) {
                if (t < view[0] || t > view[1]) {
                    continue;
                }

                const row = times.get(t) ?? new Array(series.length).fill(undefined);
                row[col] = v;
                times.set(t, row);
            }
        }

        const all = [...times.entries()].sort((a, b) => a[0] - b[0]);
        const step = Math.max(1, Math.ceil(all.length / TABLE_LIMIT));

        return { rows: all.filter((_, i) => i % step === 0), total: all.length };
    }, [series, view]);

    return (
        <div className="mt-3">
            <div className="mb-1 text-xs text-dim">
                {total.toLocaleString("en-US")} rows in view
                {rows.length < total
                    ? `, showing every ${Math.ceil(total / TABLE_LIMIT)}th (${rows.length}). Zoom in or export CSV for all.`
                    : ""}
            </div>
            <div className="max-h-80 overflow-auto rounded-card border border-line">
                <table className="w-full border-collapse text-xs">
                    <thead className="sticky top-0 bg-panel">
                        <tr>
                            <th className="px-2 py-1 text-left font-medium text-dim">Time</th>
                            {series.map((s) => (
                                <th key={s.id} className="px-2 py-1 text-right font-medium text-dim">
                                    {s.label}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map(([t, values]) => (
                            <tr key={t} className="border-t border-line/60">
                                <td className="px-2 py-0.5 font-mono text-dim">{formatTime(t, timeZone, "full")}</td>
                                {values.map((v, i) => {
                                    const s = series[i];
                                    const fmt = units?.[s.unit ?? ""]?.format ?? formatForUnit(s.unit);

                                    return (
                                        <td key={s.id} className="px-2 py-0.5 text-right font-mono text-ink">
                                            {v == null ? "" : fmt(v)}
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
