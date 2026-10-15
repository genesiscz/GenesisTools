import {
    type CSSProperties,
    type KeyboardEvent,
    type PointerEvent,
    type ReactNode,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "react";
import { SERIES_COLOR } from "./charts";
import { readableTextOn } from "./color";
import { TONE_TEXT, TONE_VAR, type Tone } from "./primitives";
import { useColorSchemeTick } from "./theme";
import { type TooltipContent, useTooltip } from "./tooltip";

/**
 * A scrollable project time chart: a header of fixed-length cells (sprints),
 * lanes with tinted header rows, one row per bar, milestone rows, a today
 * line, baseline ghosts with a shift label, and drag or keyboard editing.
 * Every colour is a CSS variable, so flipping the colour scheme retints the
 * chart with no script. Day maths runs on UTC midnights, so a clock change
 * never moves a bar.
 */

/** A calendar day as "YYYY-MM-DD". */
export type GanttDate = string;

/** `end` is the last day, inclusive. */
export interface GanttSpan {
    start: GanttDate;
    end: GanttDate;
}

export interface GanttAxis {
    start: GanttDate;
    end: GanttDate;
    /** Days per header cell. Default 14. */
    cellDays?: number;
    /** Number printed on the first cell. Default 1. */
    firstNumber?: number;
    /** Header title of a cell. Default `Sprint ${n}`. */
    cellLabel?: (n: number) => string;
    /** Pixels per day. Default 6. */
    dayWidth?: number;
}

export interface GanttLane {
    id: string;
    label: string;
    /** Any CSS color. Tints the header row and draws its left edge. Default: SERIES_COLOR by index. */
    color?: string;
    /** Right side of the header row (counts, totals). */
    meta?: ReactNode;
}

export interface GanttBar extends GanttSpan {
    id: string;
    /** GanttLane.id. */
    lane: string;
    /** Row label in the left column. The full text also sits in the title attribute. */
    label: string;
    href?: string;
    /** Any CSS color. Default: the lane color. */
    color?: string;
    /** Text inside the bar. Drawn only when the bar is wide enough. */
    barLabel?: string;
    /** 0 to 1, shaded from the left edge. */
    progress?: number;
    /** Where this bar sat in the baseline plan. */
    ghost?: GanttSpan;
    tooltip?: TooltipContent;
}

export interface GanttMilestone {
    id: string;
    label: string;
    date: GanttDate;
    tone?: Tone;
    /** Baseline date, drawn as an outlined diamond. */
    ghost?: GanttDate;
    tooltip?: TooltipContent;
}

/** A dashed full-height line with a tag (a deadline, a release). */
export interface GanttMarker {
    date: GanttDate;
    label: string;
    tone?: Tone;
}

export type GanttView = "current" | "baseline" | "compare";

export interface GanttProps {
    axis: GanttAxis;
    lanes: GanttLane[];
    bars: GanttBar[];
    milestones?: GanttMilestone[];
    markers?: GanttMarker[];
    /** `true` is the viewer's own today. A date pins it, for a report built from a snapshot. */
    today?: boolean | GanttDate;
    /** "current": bars only. "baseline": each bar at its ghost span. "compare": bars, ghosts and shift labels. Default: "compare" when any bar has a ghost. */
    view?: GanttView;
    /** Lane ids to hide (drive it from FilterChips). */
    hiddenLanes?: string[];
    /** Width of the sticky label column in px. Default 340. */
    labelWidth?: number;
    /** Height of a bar row in px. Default 24. */
    rowHeight?: number;
    /** Language for dates. Default: the browser's. */
    locale?: string;
    /** Text for a slip. Default `+12 d` or `-3 d`. */
    shiftLabel?: (days: number) => string;
    /** Turn on drag and keyboard editing. `true` allows move and both edges. */
    editable?: boolean | { move?: boolean; start?: boolean; end?: boolean };
    /** Snap step in days while dragging. Default 1. */
    snapDays?: number;
    /** Shortest bar in days. Default 1. */
    minDays?: number;
    /** "preview" fires on every snap step during a drag. "commit" fires once on release. */
    onBarChange?: (id: string, next: GanttSpan, phase: "preview" | "commit") => void;
    onBarClick?: (id: string) => void;
    ariaLabel?: string;
    /** Caption at the bottom of the label column header ("Lane / item"). */
    labelTitle?: ReactNode;
    /** Max height of the scroll frame (CSS length or px). Default: no limit. */
    maxHeight?: number | string;
}

const DAY_MS = 86_400_000;
const DEFAULT_DAY_WIDTH = 6;
const DEFAULT_CELL_DAYS = 14;
const MIN_BAR_PX = 6;
const BAR_TOP = 5;
const BAR_HEIGHT = 14;
const LANE_ROW = 30;
const HEADER = 40;
const HEADER_WITH_MARKERS = 74;

// ─── Pure helpers ───

/** Days since 1970-01-01 for a "YYYY-MM-DD" date, on UTC midnight. */
function dayNumber(date: GanttDate): number {
    const [y, m, d] = date.split("-").map(Number);

    return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function fromDayNumber(day: number): GanttDate {
    return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** Day offset of `date` from the axis start. */
export function ganttDayIndex(date: GanttDate, axisStart: GanttDate): number {
    return dayNumber(date) - dayNumber(axisStart);
}

/** `date` moved by `days`. */
export function ganttAddDays(date: GanttDate, days: number): GanttDate {
    return fromDayNumber(dayNumber(date) + days);
}

/** Inclusive length of a span in days. */
export function ganttSpanDays(span: GanttSpan): number {
    return dayNumber(span.end) - dayNumber(span.start) + 1;
}

/** Pixel position of a span on the axis. Never narrower than 6 px. */
export function ganttSpanPx(span: GanttSpan, axis: GanttAxis): { left: number; width: number } {
    const dayWidth = axis.dayWidth ?? DEFAULT_DAY_WIDTH;

    return {
        left: ganttDayIndex(span.start, axis.start) * dayWidth,
        width: Math.max(MIN_BAR_PX, ganttSpanDays(span) * dayWidth),
    };
}

/** How many days the bar's end moved from its baseline: positive is later. Null without a ghost. */
export function ganttShiftDays(bar: Pick<GanttBar, "end" | "ghost">): number | null {
    return bar.ghost ? dayNumber(bar.end) - dayNumber(bar.ghost.end) : null;
}

/** An in-bar label draws only when the bar is at least `max(42, chars * 7 + 10)` px wide. */
export function ganttBarFitsLabel(widthPx: number, text: string): boolean {
    return widthPx >= Math.max(42, text.length * 7 + 10);
}

/**
 * The span after dragging `edge` by `dxPx`, snapped to `snapDays`. An edge
 * stops where the bar would get shorter than `minDays`.
 */
export function ganttDragSpan(
    origin: GanttSpan,
    edge: "start" | "end" | "move",
    dxPx: number,
    axis: GanttAxis,
    snapDays: number,
    minDays: number
): GanttSpan {
    const dayWidth = axis.dayWidth ?? DEFAULT_DAY_WIDTH;
    const step = Math.max(1, snapDays);
    const days = Math.round(dxPx / dayWidth / step) * step;
    const shortest = Math.max(1, minDays) - 1;

    if (edge === "move") {
        return { start: ganttAddDays(origin.start, days), end: ganttAddDays(origin.end, days) };
    }

    if (edge === "end") {
        const end = Math.max(dayNumber(origin.end) + days, dayNumber(origin.start) + shortest);

        return { start: origin.start, end: fromDayNumber(end) };
    }

    const start = Math.min(dayNumber(origin.start) + days, dayNumber(origin.end) - shortest);

    return { start: fromDayNumber(start), end: origin.end };
}

export interface GanttCell {
    number: number;
    start: GanttDate;
    end: GanttDate;
    /** Short range, month and day only ("9/17 to 9/30"). */
    range: string;
    /** Year, only on the first cell of each year. */
    year?: number;
    /** Full range with years, for the title attribute. */
    title: string;
}

function dateFormat(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
}

function utcDate(date: GanttDate): Date {
    return new Date(dayNumber(date) * DAY_MS);
}

/** The header cells of an axis. The short range never carries a year, so it cannot clip at 84 px. */
export function ganttCells(axis: GanttAxis, locale?: string): GanttCell[] {
    const cellDays = axis.cellDays ?? DEFAULT_CELL_DAYS;
    const total = ganttDayIndex(axis.end, axis.start) + 1;
    const short = dateFormat(locale, { day: "numeric", month: "numeric" });
    const long = dateFormat(locale, { day: "numeric", month: "short", year: "numeric" });
    const label = axis.cellLabel ?? ((n: number): string => `Sprint ${n}`);
    const cells: GanttCell[] = [];
    let lastYear: number | null = null;

    for (let i = 0; i * cellDays < total; i += 1) {
        const start = ganttAddDays(axis.start, i * cellDays);
        const end = ganttAddDays(axis.start, Math.min(total, (i + 1) * cellDays) - 1);
        const year = Number(start.slice(0, 4));
        const number = (axis.firstNumber ?? 1) + i;
        cells.push({
            number,
            start,
            end,
            range: `${short.format(utcDate(start))} to ${short.format(utcDate(end))}`,
            year: year !== lastYear ? year : undefined,
            title: `${label(number)}: ${long.format(utcDate(start))} to ${long.format(utcDate(end))}`,
        });
        lastYear = year;
    }

    return cells;
}

/** Default slip text: "+12 d", "-3 d". */
export function ganttShiftText(days: number): string {
    return `${days > 0 ? "+" : ""}${days} d`;
}

function localToday(): GanttDate {
    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, "0");

    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

interface EditRights {
    move: boolean;
    start: boolean;
    end: boolean;
}

function editRights(editable: GanttProps["editable"]): EditRights {
    if (editable === true) {
        return { move: true, start: true, end: true };
    }

    if (!editable) {
        return { move: false, start: false, end: false };
    }

    return { move: editable.move ?? false, start: editable.start ?? false, end: editable.end ?? false };
}

// ─── Component ───

interface DragState {
    id: string;
    edge: "start" | "end" | "move";
    x0: number;
    origin: GanttSpan;
    preview: GanttSpan;
    moved: boolean;
}

type Row =
    | { kind: "lane"; lane: GanttLane; color: string }
    | { kind: "bar"; bar: GanttBar; color: string }
    | { kind: "milestone"; milestone: GanttMilestone };

interface Formatters {
    day: Intl.DateTimeFormat;
}

function rangeText(span: GanttSpan, fmt: Formatters): string {
    return `${fmt.day.format(utcDate(span.start))} to ${fmt.day.format(utcDate(span.end))}`;
}

function barSentence(bar: GanttBar, span: GanttSpan, fmt: Formatters, shift: number | null): string {
    const parts = [bar.label, rangeText(span, fmt), `${ganttSpanDays(span)} days`];

    if (bar.barLabel) {
        parts.push(bar.barLabel);
    }

    if (shift) {
        parts.push(`${Math.abs(shift)} days ${shift > 0 ? "later" : "earlier"} than baseline`);
    }

    return parts.join(", ");
}

/** Project time chart. See the module comment; `GanttTable` is the table equivalent. */
export function Gantt({
    axis,
    lanes,
    bars,
    milestones = [],
    markers = [],
    today,
    view,
    hiddenLanes = [],
    labelWidth = 340,
    rowHeight = 24,
    locale,
    shiftLabel = ganttShiftText,
    editable = false,
    snapDays = 1,
    minDays = 1,
    onBarChange,
    onBarClick,
    ariaLabel = "Project timeline",
    maxHeight,
    labelTitle,
}: GanttProps) {
    const dayWidth = axis.dayWidth ?? DEFAULT_DAY_WIDTH;
    const cellWidth = (axis.cellDays ?? DEFAULT_CELL_DAYS) * dayWidth;
    const totalDays = ganttDayIndex(axis.end, axis.start) + 1;
    const trackWidth = totalDays * dayWidth;
    const headerHeight = markers.length > 0 ? HEADER_WITH_MARKERS : HEADER;
    const mode: GanttView = view ?? (bars.some((b) => b.ghost) ? "compare" : "current");
    const rights = editRights(editable);
    const fmt: Formatters = { day: dateFormat(locale, { day: "numeric", month: "short" }) };
    const [drag, setDrag] = useState<DragState | null>(null);
    const dragRef = useRef<DragState | null>(null);
    const [active, setActive] = useState(0);
    const [announce, setAnnounce] = useState("");
    const itemRefs = useRef(new Map<number, HTMLElement>());
    const focusNext = useRef(false);
    // Re-render on a scheme flip, so the in-bar text re-picks its colour against the new fills.
    useColorSchemeTick();

    const rows: Row[] = milestones.map((milestone) => ({ kind: "milestone", milestone }));
    lanes.forEach((lane, laneIndex) => {
        if (hiddenLanes.includes(lane.id)) {
            return;
        }

        const color = lane.color ?? SERIES_COLOR[laneIndex % SERIES_COLOR.length];
        rows.push({ kind: "lane", lane, color });

        for (const bar of bars) {
            if (bar.lane === lane.id) {
                rows.push({ kind: "bar", bar, color: bar.color ?? color });
            }
        }
    });

    // Roving tab order: milestones and bars, top to bottom.
    const focusable = rows.filter((row) => row.kind !== "lane");
    const activeIndex = Math.min(active, Math.max(0, focusable.length - 1));

    useEffect(() => {
        if (focusNext.current) {
            focusNext.current = false;
            itemRefs.current.get(activeIndex)?.focus();
        }
    }, [activeIndex]);

    const spanOf = (bar: GanttBar): GanttSpan => {
        if (drag && drag.id === bar.id) {
            return drag.preview;
        }

        return mode === "baseline" && bar.ghost ? bar.ghost : { start: bar.start, end: bar.end };
    };

    const endDrag = (commit: boolean): void => {
        const current = dragRef.current;
        dragRef.current = null;
        setDrag(null);

        if (!current) {
            return;
        }

        if (!current.moved) {
            if (commit) {
                onBarClick?.(current.id);
            }

            return;
        }

        if (commit) {
            onBarChange?.(current.id, current.preview, "commit");
        }
    };

    useEffect(() => {
        if (!drag) {
            return;
        }

        const onKey = (event: globalThis.KeyboardEvent): void => {
            if (event.key === "Escape") {
                endDrag(false);
            }
        };
        document.addEventListener("keydown", onKey);

        return () => document.removeEventListener("keydown", onKey);
    });

    const onBarPointerDown = (event: PointerEvent<HTMLElement>, bar: GanttBar): void => {
        if (event.button !== 0 || mode === "baseline") {
            return;
        }

        const handle =
            event.target instanceof Element
                ? event.target.closest("[data-gantt-handle]")?.getAttribute("data-gantt-handle")
                : null;
        const edge = handle === "start" || handle === "end" ? handle : "move";
        const allowed = edge === "move" ? rights.move : rights[edge];

        if (!allowed && !onBarClick) {
            return;
        }

        event.preventDefault();
        const capture = event.target instanceof Element ? event.target : event.currentTarget;
        capture.setPointerCapture?.(event.pointerId);
        const origin = { start: bar.start, end: bar.end };
        // A click-only bar records the press (x0 NaN) but never previews a move.
        dragRef.current = {
            id: bar.id,
            edge: allowed ? edge : "move",
            x0: allowed ? event.clientX : Number.NaN,
            origin,
            preview: origin,
            moved: false,
        };
        setDrag(dragRef.current);
    };

    const onBarPointerMove = (event: PointerEvent<HTMLElement>): void => {
        const current = dragRef.current;

        if (!current || Number.isNaN(current.x0)) {
            return;
        }

        const preview = ganttDragSpan(
            current.origin,
            current.edge,
            event.clientX - current.x0,
            axis,
            snapDays,
            minDays
        );

        if (preview.start === current.preview.start && preview.end === current.preview.end) {
            return;
        }

        const next = { ...current, preview, moved: true };
        dragRef.current = next;
        setDrag(next);
        onBarChange?.(current.id, preview, "preview");
    };

    const keyEdit = (bar: GanttBar, event: KeyboardEvent<HTMLElement>): boolean => {
        const dir = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;

        if (dir === 0) {
            return false;
        }

        const edge: DragState["edge"] = event.shiftKey ? (event.altKey ? "start" : "end") : "move";
        const allowed = edge === "move" ? rights.move : rights[edge];

        if (!allowed) {
            return false;
        }

        const next = ganttDragSpan(
            { start: bar.start, end: bar.end },
            edge,
            dir * snapDays * dayWidth,
            axis,
            snapDays,
            minDays
        );

        if (next.start === bar.start && next.end === bar.end) {
            return true;
        }

        onBarChange?.(bar.id, next, "commit");
        setAnnounce(`${bar.label} now ${rangeText(next, fmt)}, ${ganttSpanDays(next)} days`);

        return true;
    };

    const onItemKeyDown = (event: KeyboardEvent<HTMLElement>, index: number): void => {
        const row = focusable[index];
        let target = index;

        if (event.key === "ArrowDown") {
            target = Math.min(focusable.length - 1, index + 1);
        } else if (event.key === "ArrowUp") {
            target = Math.max(0, index - 1);
        } else if (event.key === "Home") {
            target = 0;
        } else if (event.key === "End") {
            target = focusable.length - 1;
        } else if (event.key === "Enter" && row?.kind === "bar" && onBarClick) {
            event.preventDefault();
            onBarClick(row.bar.id);

            return;
        } else if (row?.kind === "bar" && !(mode === "baseline") && keyEdit(row.bar, event)) {
            event.preventDefault();

            return;
        } else {
            return;
        }

        event.preventDefault();

        if (target !== index) {
            focusNext.current = true;
            setActive(target);
        }
    };

    const todayDate = today === true ? localToday() : typeof today === "string" ? today : null;
    const todayIndex = todayDate ? ganttDayIndex(todayDate, axis.start) : -1;
    const showToday = todayDate !== null && todayIndex >= 0 && todayIndex < totalDays;
    const cells = ganttCells(axis, locale);
    const bandLayer: CSSProperties = {
        backgroundImage: [
            `repeating-linear-gradient(to right, var(--border) 0 1px, transparent 1px ${cellWidth}px)`,
            `repeating-linear-gradient(to right, transparent 0 ${cellWidth}px, var(--wash) ${cellWidth}px ${cellWidth * 2}px)`,
        ].join(", "),
    };
    let focusIndex = -1;

    return (
        <div
            role="group"
            aria-label={ariaLabel}
            className="relative overflow-auto rounded-card border border-line bg-panel text-ink"
            style={{ maxHeight }}
            data-gantt=""
        >
            <div className="relative" style={{ width: labelWidth + trackWidth }}>
                {/* Header */}
                <div className="sticky top-0 z-30 flex border-b border-line bg-panel" style={{ height: headerHeight }}>
                    <div
                        className="sticky left-0 z-40 flex shrink-0 items-end border-r border-line bg-panel px-3 pb-2 text-xs text-dim"
                        style={{ width: labelWidth }}
                    >
                        {labelTitle}
                    </div>
                    <div className="relative" style={{ width: trackWidth }}>
                        {cells.map((cell, i) => (
                            <div
                                key={cell.start}
                                title={cell.title}
                                data-gantt-cell=""
                                className="absolute bottom-0 overflow-hidden border-l border-line pt-1 pl-[7px] text-[11px] leading-tight whitespace-nowrap"
                                style={{ left: i * cellWidth, width: cellWidth, height: HEADER }}
                            >
                                <div className="font-semibold text-ink tabular-nums">
                                    {cell.number}
                                    {cell.year ? (
                                        <span className="ml-1.5 font-normal text-dim">{cell.year}</span>
                                    ) : null}
                                </div>
                                <div className="text-dim tabular-nums" data-gantt-range="">
                                    {cell.range}
                                </div>
                            </div>
                        ))}
                        {markers.map((marker) => {
                            const at = (ganttDayIndex(marker.date, axis.start) + 0.5) * dayWidth;

                            return (
                                <span
                                    key={`${marker.date}-${marker.label}`}
                                    className={`absolute top-1.5 -translate-x-1/2 rounded border bg-panel px-1 text-[10px] whitespace-nowrap ${TONE_TEXT[marker.tone ?? "neutral"]}`}
                                    style={{ left: at, borderColor: TONE_VAR[marker.tone ?? "neutral"] }}
                                >
                                    {marker.label}
                                </span>
                            );
                        })}
                        {showToday ? (
                            <span
                                data-gantt-today-tag=""
                                className="absolute top-0.5 z-10 -translate-x-1/2 rounded border border-line bg-panel px-1 text-[10px] text-ink"
                                style={{ left: (todayIndex + 0.5) * dayWidth }}
                            >
                                today
                            </span>
                        ) : null}
                    </div>
                </div>

                {/* Body */}
                <div className="relative">
                    <div
                        aria-hidden="true"
                        data-gantt-bands=""
                        className="pointer-events-none absolute top-0 bottom-0"
                        style={{ left: labelWidth, width: trackWidth, ...bandLayer }}
                    />
                    {rows.map((row) => {
                        if (row.kind === "lane") {
                            return (
                                <LaneRow
                                    key={`lane-${row.lane.id}`}
                                    lane={row.lane}
                                    color={row.color}
                                    labelWidth={labelWidth}
                                    trackWidth={trackWidth}
                                />
                            );
                        }

                        focusIndex += 1;
                        const index = focusIndex;
                        const register = (el: HTMLElement | null): void => {
                            if (el) {
                                itemRefs.current.set(index, el);
                            } else {
                                itemRefs.current.delete(index);
                            }
                        };
                        const common = {
                            index,
                            tabIndex: index === activeIndex ? 0 : -1,
                            register,
                            onFocus: () => setActive(index),
                            onKeyDown: (event: KeyboardEvent<HTMLElement>) => onItemKeyDown(event, index),
                            labelWidth,
                            trackWidth,
                            axis,
                            fmt,
                        };

                        if (row.kind === "milestone") {
                            return (
                                <MilestoneRow key={`ms-${row.milestone.id}`} milestone={row.milestone} {...common} />
                            );
                        }

                        const span = spanOf(row.bar);
                        const shift = mode === "compare" ? ganttShiftDays(row.bar) : null;

                        return (
                            <BarRow
                                key={`bar-${row.bar.id}`}
                                bar={row.bar}
                                color={row.color}
                                span={span}
                                ghost={mode === "compare" ? row.bar.ghost : undefined}
                                shift={shift}
                                shiftLabel={shiftLabel}
                                rowHeight={rowHeight}
                                rights={mode === "baseline" ? editRights(false) : rights}
                                clickable={Boolean(onBarClick)}
                                dragging={drag?.id === row.bar.id && drag.moved}
                                dragEdge={drag?.id === row.bar.id ? drag.edge : "move"}
                                onPointerDown={(event) => onBarPointerDown(event, row.bar)}
                                onPointerMove={onBarPointerMove}
                                onPointerUp={() => endDrag(true)}
                                onPointerCancel={() => endDrag(false)}
                                {...common}
                            />
                        );
                    })}
                    <div
                        aria-hidden="true"
                        className="pointer-events-none absolute top-0 bottom-0 z-10"
                        style={{ left: labelWidth, width: trackWidth }}
                    >
                        {showToday ? (
                            <div
                                data-gantt-today=""
                                className="absolute top-0 bottom-0 -translate-x-1/2"
                                style={{
                                    left: (todayIndex + 0.5) * dayWidth,
                                    width: 1.5,
                                    background: "color-mix(in srgb, var(--text) 55%, transparent)",
                                }}
                            />
                        ) : null}
                        {markers.map((marker) => (
                            <div
                                key={`line-${marker.date}-${marker.label}`}
                                data-gantt-marker=""
                                className="absolute top-0 bottom-0 -translate-x-1/2 border-l-[1.5px] border-dashed"
                                style={{
                                    left: (ganttDayIndex(marker.date, axis.start) + 0.5) * dayWidth,
                                    borderColor: TONE_VAR[marker.tone ?? "neutral"],
                                }}
                            />
                        ))}
                    </div>
                </div>
            </div>
            <div aria-live="polite" className="sr-only" data-gantt-live="">
                {announce}
            </div>
        </div>
    );
}

interface RowCommon {
    index: number;
    tabIndex: number;
    register: (el: HTMLElement | null) => void;
    onFocus: () => void;
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
    labelWidth: number;
    trackWidth: number;
    axis: GanttAxis;
    fmt: Formatters;
}

const LABEL_CELL = "sticky left-0 z-20 flex shrink-0 items-center border-r border-line px-3";

function LaneRow({
    lane,
    color,
    labelWidth,
    trackWidth,
}: {
    lane: GanttLane;
    color: string;
    labelWidth: number;
    trackWidth: number;
}) {
    const tint = `color-mix(in oklab, ${color} 12%, var(--panel))`;

    return (
        <div
            data-gantt-row="lane"
            className="relative flex border-b border-line/70"
            style={{ height: LANE_ROW, borderTop: `2px solid ${color}`, background: tint }}
        >
            <div className={`${LABEL_CELL} gap-2`} style={{ width: labelWidth, background: tint }}>
                <span aria-hidden="true" className="h-4 w-1 shrink-0 rounded-sm" style={{ background: color }} />
                <span className="min-w-0 flex-1 truncate text-[13px] font-[750]">{lane.label}</span>
                {lane.meta ? <span className="shrink-0 text-xs text-dim">{lane.meta}</span> : null}
            </div>
            <div style={{ width: trackWidth }} />
        </div>
    );
}

function MilestoneRow({
    milestone,
    index,
    tabIndex,
    register,
    onFocus,
    onKeyDown,
    labelWidth,
    trackWidth,
    axis,
    fmt,
}: RowCommon & { milestone: GanttMilestone }) {
    const dayWidth = axis.dayWidth ?? DEFAULT_DAY_WIDTH;
    const at = (ganttDayIndex(milestone.date, axis.start) + 0.5) * dayWidth;
    const ghostAt =
        milestone.ghost && milestone.ghost !== milestone.date
            ? (ganttDayIndex(milestone.ghost, axis.start) + 0.5) * dayWidth
            : null;
    const dateText = fmt.day.format(utcDate(milestone.date));
    const tip = useTooltip(
        () =>
            milestone.tooltip ?? {
                title: milestone.label,
                rows: [
                    { k: "Date", v: dateText },
                    ...(milestone.ghost ? [{ k: "Baseline", v: fmt.day.format(utcDate(milestone.ghost)) }] : []),
                ],
            }
    );
    const tint = "color-mix(in oklab, var(--info) 10%, var(--panel))";

    return (
        <div
            data-gantt-row="milestone"
            className="relative flex border-y-[1.5px] border-line"
            style={{ height: 26, background: tint }}
        >
            <div className={LABEL_CELL} style={{ width: labelWidth, background: tint }}>
                <span className="truncate text-[12.5px] font-bold" title={milestone.label}>
                    {milestone.label}
                </span>
            </div>
            <div className="relative" style={{ width: trackWidth }}>
                {ghostAt !== null ? (
                    <span
                        aria-hidden="true"
                        className="absolute top-1/2 h-3 w-3 rotate-45 border border-dashed border-dim"
                        style={{ left: ghostAt - 6, marginTop: -6 }}
                    />
                ) : null}
                <span
                    ref={register}
                    role="img"
                    tabIndex={tabIndex}
                    data-gantt-index={index}
                    data-gantt-milestone=""
                    aria-label={`${milestone.label}, ${dateText}`}
                    onFocus={(event) => {
                        onFocus();
                        tip.onFocus(event);
                    }}
                    onBlur={tip.onBlur}
                    onKeyDown={(event) => {
                        tip.onKeyDown(event);
                        onKeyDown(event);
                    }}
                    onPointerMove={tip.onPointerMove}
                    onPointerLeave={tip.onPointerLeave}
                    onPointerDown={tip.onPointerDown}
                    aria-describedby={tip["aria-describedby"]}
                    className="group absolute top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-info"
                    style={{ left: at - 12 }}
                >
                    <span
                        className="block h-[14px] w-[14px] rotate-45 rounded-[2px] border-[2.5px] bg-panel group-hover:bg-ink group-focus-visible:bg-ink"
                        style={{ borderColor: milestone.tone ? TONE_VAR[milestone.tone] : "var(--text)" }}
                    />
                </span>
                <span className="absolute top-1/2 -translate-y-1/2 text-[10px] text-dim" style={{ left: at + 12 }}>
                    {dateText}
                </span>
            </div>
        </div>
    );
}

interface BarRowProps extends RowCommon {
    bar: GanttBar;
    color: string;
    span: GanttSpan;
    ghost?: GanttSpan;
    shift: number | null;
    shiftLabel: (days: number) => string;
    rowHeight: number;
    rights: EditRights;
    clickable: boolean;
    dragging: boolean;
    /** Which part of the bar the drag holds, for the drag tag. */
    dragEdge: "start" | "end" | "move";
    onPointerDown: (event: PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: PointerEvent<HTMLElement>) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
}

/** A resize grip: 9 px, reaching 4 px past the bar edge, shown on hover, focus and drag. */
const HANDLE =
    "absolute -top-[3px] -bottom-[3px] w-[9px] cursor-ew-resize touch-none rounded-[3px] bg-ink opacity-0 group-hover:opacity-60 group-focus-visible:opacity-60";
/** The baseline outline is a thin dashed band centred on the bar, so the bar itself stays readable over it. */
const GHOST_HEIGHT = 6;

function BarRow({
    bar,
    color,
    span,
    ghost,
    shift,
    shiftLabel,
    rowHeight,
    rights,
    clickable,
    dragging,
    dragEdge,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    index,
    tabIndex,
    register,
    onFocus,
    onKeyDown,
    labelWidth,
    trackWidth,
    axis,
    fmt,
}: BarRowProps) {
    const { left, width } = ganttSpanPx(span, axis);
    const showGhost = ghost && (ghost.start !== span.start || ghost.end !== span.end);
    const ghostPx = showGhost && ghost ? ganttSpanPx(ghost, axis) : null;
    const labelFits = bar.barLabel ? ganttBarFitsLabel(width, bar.barLabel) : false;
    const barRef = useRef<HTMLElement | null>(null);
    const textRef = useRef<HTMLSpanElement>(null);
    const interactive = clickable || rights.move || rights.start || rights.end;
    const sentence = barSentence(bar, span, fmt, shift);
    const tip = useTooltip(
        dragging
            ? {
                  title: bar.label,
                  rows: [
                      { k: "New range", v: rangeText(span, fmt) },
                      { k: "Length", v: `${ganttSpanDays(span)} days` },
                  ],
              }
            : () =>
                  bar.tooltip ?? {
                      title: bar.label,
                      rows: [
                          { k: "Dates", v: rangeText(span, fmt) },
                          { k: "Length", v: `${ganttSpanDays(span)} days` },
                          ...(bar.barLabel ? [{ k: "Value", v: bar.barLabel }] : []),
                          ...(shift
                              ? [
                                    {
                                        k: "Shift",
                                        v: shiftLabel(shift),
                                        tone: shift > 0 ? ("err" as const) : ("ok" as const),
                                    },
                                ]
                              : []),
                      ],
                  }
    );

    const ghostTip = useTooltip(() => ({
        title: "Baseline plan",
        subtitle: bar.label,
        rows: [
            { k: "Baseline", v: ghost ? rangeText(ghost, fmt) : "none" },
            { k: "Now", v: rangeText(span, fmt) },
        ],
        note: "The dashed outline is where this item sat in the baseline plan. The solid bar is where it sits now.",
    }));
    const shiftTip = useTooltip(() => ({
        title: `End shift ${shift ? shiftLabel(shift) : ""}`,
        subtitle: bar.label,
        rows: [
            { k: "Baseline end", v: ghost ? fmt.day.format(utcDate(ghost.end)) : "none" },
            { k: "End now", v: fmt.day.format(utcDate(span.end)) },
        ],
        note: "Calendar days against the baseline. A positive number is a delay.",
    }));

    // In-bar text colour by contrast against the RESOLVED bar colour, so a light series stays readable.
    useLayoutEffect(() => {
        if (textRef.current && barRef.current) {
            textRef.current.style.color = readableTextOn(getComputedStyle(barRef.current).backgroundColor);
        }
    });

    const shiftNearEdge = left + width + 6 + 48 > trackWidth;

    return (
        <div data-gantt-row="bar" className="relative flex border-b border-line/70" style={{ height: rowHeight }}>
            <div className={LABEL_CELL} style={{ width: labelWidth, background: "var(--panel)" }}>
                {bar.href ? (
                    <a
                        href={bar.href}
                        title={bar.label}
                        tabIndex={-1}
                        className="truncate text-[12.5px] text-dim hover:text-ink hover:underline"
                    >
                        {bar.label}
                    </a>
                ) : (
                    <span title={bar.label} className="truncate text-[12.5px] text-dim">
                        {bar.label}
                    </span>
                )}
            </div>
            <div className="relative" style={{ width: trackWidth }}>
                {ghostPx ? (
                    <span
                        aria-hidden="true"
                        data-gantt-ghost=""
                        className="absolute cursor-help rounded-[3px] border border-dashed border-dim hover:border-ink hover:bg-[var(--wash)]"
                        style={{
                            left: ghostPx.left,
                            width: ghostPx.width,
                            top: BAR_TOP + (BAR_HEIGHT - GHOST_HEIGHT) / 2,
                            height: GHOST_HEIGHT,
                        }}
                        onPointerMove={ghostTip.onPointerMove}
                        onPointerLeave={ghostTip.onPointerLeave}
                    />
                ) : null}
                <span
                    ref={(el) => {
                        barRef.current = el;
                        register(el);
                    }}
                    role={interactive ? "button" : "img"}
                    tabIndex={tabIndex}
                    aria-label={sentence}
                    data-gantt-index={index}
                    data-gantt-bar={bar.id}
                    onFocus={(event) => {
                        onFocus();
                        tip.onFocus(event);
                    }}
                    onBlur={tip.onBlur}
                    onKeyDown={(event) => {
                        tip.onKeyDown(event);
                        onKeyDown(event);
                    }}
                    onPointerMove={(event) => {
                        tip.onPointerMove(event);
                        onPointerMove(event);
                    }}
                    onPointerLeave={tip.onPointerLeave}
                    onPointerDown={(event) => {
                        tip.onPointerDown(event);
                        onPointerDown(event);
                    }}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerCancel}
                    aria-describedby={tip["aria-describedby"]}
                    className={`group absolute block rounded hover:brightness-[1.12] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-info motion-safe:transition-[filter] ${
                        rights.move
                            ? "cursor-grab touch-none active:cursor-grabbing"
                            : interactive
                              ? "cursor-pointer"
                              : ""
                    } ${dragging ? "z-[5] brightness-[1.12] outline-2 outline-offset-1 outline-solid outline-ink" : ""}`}
                    style={{ left, width, top: BAR_TOP, height: BAR_HEIGHT, background: color }}
                >
                    {bar.progress ? (
                        <span aria-hidden="true" className="absolute inset-0 overflow-hidden rounded">
                            <span
                                className="absolute top-0 bottom-0 left-0"
                                style={{
                                    width: `${Math.max(0, Math.min(1, bar.progress)) * 100}%`,
                                    background: "rgba(0,0,0,.3)",
                                }}
                            />
                        </span>
                    ) : null}
                    {labelFits ? (
                        <span
                            ref={textRef}
                            aria-hidden="true"
                            data-gantt-bar-label=""
                            className="pointer-events-none relative block text-center text-[10px] leading-[14px] font-semibold whitespace-nowrap"
                        >
                            {bar.barLabel}
                        </span>
                    ) : null}
                    {rights.start ? (
                        <span
                            data-gantt-handle="start"
                            className={`${HANDLE} -left-1 ${dragging ? "opacity-60" : ""}`}
                        />
                    ) : null}
                    {rights.end ? (
                        <span
                            data-gantt-handle="end"
                            className={`${HANDLE} -right-1 ${dragging ? "opacity-60" : ""}`}
                        />
                    ) : null}
                    {dragging ? (
                        <span
                            data-gantt-drag-tag=""
                            aria-hidden="true"
                            className="pointer-events-none absolute -top-px z-10 -translate-x-1/2 -translate-y-full rounded border border-line bg-panel px-1.5 text-[10px] whitespace-nowrap text-ink"
                            style={{ left: dragEdge === "end" ? "100%" : 0 }}
                        >
                            {dragEdge === "end"
                                ? `to ${fmt.day.format(utcDate(span.end))}, ${ganttSpanDays(span)} days`
                                : dragEdge === "start"
                                  ? `from ${fmt.day.format(utcDate(span.start))}, ${ganttSpanDays(span)} days`
                                  : `from ${fmt.day.format(utcDate(span.start))}`}
                        </span>
                    ) : null}
                </span>
                {shift ? (
                    <span
                        data-gantt-shift=""
                        aria-hidden="true"
                        onPointerMove={shiftTip.onPointerMove}
                        onPointerLeave={shiftTip.onPointerLeave}
                        className={`absolute cursor-help text-[10px] leading-[14px] font-semibold whitespace-nowrap tabular-nums ${shift > 0 ? "text-err" : "text-ok"}`}
                        style={
                            shiftNearEdge
                                ? { right: trackWidth - left + 6, top: BAR_TOP }
                                : { left: left + width + 6, top: BAR_TOP }
                        }
                    >
                        {shiftLabel(shift)}
                    </span>
                ) : null}
            </div>
        </div>
    );
}

export interface GanttTableProps {
    lanes: GanttLane[];
    bars: GanttBar[];
    milestones?: GanttMilestone[];
    locale?: string;
    view?: GanttView;
}

/** The chart as a plain table (lane, item, start, end, days, shift): the non-visual equivalent. */
export function GanttTable({ lanes, bars, milestones = [], locale, view }: GanttTableProps) {
    const fmt = dateFormat(locale, { day: "numeric", month: "short", year: "numeric" });
    const mode: GanttView = view ?? (bars.some((b) => b.ghost) ? "compare" : "current");
    const laneName = new Map(lanes.map((lane) => [lane.id, lane.label]));
    const cell = "px-3 py-1.5 align-top";
    const num = `${cell} text-right font-mono text-[0.82rem] tabular-nums`;

    return (
        <div className="my-3 overflow-x-auto rounded-card border border-line">
            <table className="w-full text-sm">
                <thead>
                    <tr className="bg-panel text-left text-xs text-dim">
                        {["Lane", "Item", "Start", "End", "Days", "Shift"].map((h) => (
                            <th
                                key={h}
                                scope="col"
                                className={`px-3 py-2 font-semibold ${h === "Days" || h === "Shift" ? "text-right" : ""}`}
                            >
                                {h}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {milestones.map((m) => (
                        <tr key={`ms-${m.id}`} className="border-t border-line/70">
                            <td className={cell}>Milestone</td>
                            <td className={cell}>{m.label}</td>
                            <td className={cell}>{fmt.format(utcDate(m.date))}</td>
                            <td className={cell} />
                            <td className={num} />
                            <td className={num}>
                                {m.ghost && m.ghost !== m.date && mode === "compare"
                                    ? ganttShiftText(dayNumber(m.date) - dayNumber(m.ghost))
                                    : ""}
                            </td>
                        </tr>
                    ))}
                    {bars.map((bar) => {
                        const span = mode === "baseline" && bar.ghost ? bar.ghost : bar;
                        const shift = mode === "compare" ? ganttShiftDays(bar) : null;

                        return (
                            <tr key={bar.id} className="border-t border-line/70">
                                <td className={cell}>{laneName.get(bar.lane) ?? bar.lane}</td>
                                <th scope="row" className={`${cell} text-left font-normal`}>
                                    {bar.label}
                                </th>
                                <td className={cell}>{fmt.format(utcDate(span.start))}</td>
                                <td className={cell}>{fmt.format(utcDate(span.end))}</td>
                                <td className={num}>{ganttSpanDays(span)}</td>
                                <td className={`${num} ${shift ? (shift > 0 ? "text-err" : "text-ok") : ""}`}>
                                    {shift ? ganttShiftText(shift) : ""}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
