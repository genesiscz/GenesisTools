import { type CSSProperties, useId } from "react";
import { TONE_COLOR } from "./charts";
import { TONE_DOT, TONE_TEXT, type Tone } from "./primitives";
import { useTooltip } from "./tooltip";

/**
 * Small dependency-free visuals that sit INSIDE other components: a sparkline
 * for a table cell or stat tile, a meter for a budget or a percentage, a grid
 * heatmap for "when does it happen". Colors come from the theme tones.
 */

// ─── Sparkline ───

export interface SparklineProps {
    values: number[];
    width?: number;
    height?: number;
    tone?: Tone;
    /** Any CSS color; wins over `tone`. */
    color?: string;
    kind?: "line" | "bar";
    /** Dot on the last point (default on). */
    markLast?: boolean;
    ariaLabel?: string;
}

const PAD = 1.5;

/** SVG path for the polyline through `values`, normalized into width x height. */
export function sparklinePath(values: number[], width: number, height: number): string {
    if (values.length === 0) {
        return "";
    }

    const min = Math.min(...values);
    const span = Math.max(...values) - min || 1;
    const stepX = values.length > 1 ? (width - PAD * 2) / (values.length - 1) : 0;

    return values
        .map((v, i) => {
            const x = (PAD + i * stepX).toFixed(2);
            const y = (height - PAD - ((v - min) / span) * (height - PAD * 2)).toFixed(2);

            return `${i === 0 ? "M" : "L"}${x},${y}`;
        })
        .join(" ");
}

/** Inline trend glyph. Sized in px so it fits a table cell or a stat label. */
export function Sparkline({
    values,
    width = 120,
    height = 28,
    tone = "info",
    color,
    kind = "line",
    markLast = true,
    ariaLabel,
}: SparklineProps) {
    const stroke = color ?? TONE_COLOR[tone];
    const min = Math.min(...values);
    const span = Math.max(...values) - min || 1;
    const last = values.length - 1;
    const slot = (width - PAD * 2) / Math.max(values.length, 1);

    return (
        <svg
            role="img"
            aria-label={ariaLabel ?? `trend of ${values.length} values`}
            viewBox={`0 0 ${width} ${height}`}
            width={width}
            height={height}
            className="inline-block overflow-visible align-middle"
        >
            {kind === "bar" ? (
                values.map((v, i) => {
                    const h = Math.max(1, ((v - min) / span) * (height - PAD * 2));

                    return (
                        <rect
                            key={`${i}-${v}`}
                            x={PAD + i * slot + slot * 0.15}
                            y={height - PAD - h}
                            width={slot * 0.7}
                            height={h}
                            fill={stroke}
                            opacity={i === last && markLast ? 1 : 0.6}
                        />
                    );
                })
            ) : (
                <>
                    <path
                        d={sparklinePath(values, width, height)}
                        fill="none"
                        stroke={stroke}
                        strokeWidth={1.5}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                    />
                    {markLast && values.length > 0 ? (
                        <circle
                            cx={PAD + last * (values.length > 1 ? (width - PAD * 2) / last : 0)}
                            cy={height - PAD - ((values[last] - min) / span) * (height - PAD * 2)}
                            r={2.2}
                            fill={stroke}
                        />
                    ) : null}
                </>
            )}
        </svg>
    );
}

// ─── Meter ───

export interface MeterThresholds {
    /** At or above this value the meter turns warn. */
    warn?: number;
    /** At or above this value the meter turns err. */
    err?: number;
}

export interface MeterProps {
    value: number;
    max?: number;
    min?: number;
    label?: string;
    /** Value text on the right (default: `value/max`, or a percentage when max is 100). */
    display?: string;
    /** Fixed tone; wins over `thresholds`. */
    tone?: Tone;
    /** Tone by value: ok below `warn`, warn from there, err from `err`. */
    thresholds?: MeterThresholds;
    size?: "sm" | "md";
}

/** Tone for a meter value: explicit tone, else thresholds, else info. */
export function meterTone(value: number, thresholds?: MeterThresholds, tone?: Tone): Tone {
    if (tone) {
        return tone;
    }

    if (!thresholds) {
        return "info";
    }

    if (thresholds.err !== undefined && value >= thresholds.err) {
        return "err";
    }

    if (thresholds.warn !== undefined && value >= thresholds.warn) {
        return "warn";
    }

    return "ok";
}

/** Horizontal bar for a quota, a budget, a completion percentage. */
export function Meter({ value, max = 100, min = 0, label, display, tone, thresholds, size = "sm" }: MeterProps) {
    const pct = Math.max(0, Math.min(100, ((value - min) / (max - min || 1)) * 100));
    const t = meterTone(value, thresholds, tone);
    const text = display ?? (max === 100 && min === 0 ? `${Math.round(pct)}%` : `${value}/${max}`);

    return (
        <div className="my-1.5">
            <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
                <span className="text-dim">{label}</span>
                <span className={`font-mono ${TONE_TEXT[t]}`}>{text}</span>
            </div>
            <div
                role="meter"
                aria-valuenow={value}
                aria-valuemin={min}
                aria-valuemax={max}
                aria-label={label ?? text}
                className={`w-full overflow-hidden rounded-full bg-panel ${size === "md" ? "h-2.5" : "h-1.5"}`}
            >
                <div className={`h-full rounded-full ${TONE_DOT[t]}`} style={{ width: `${pct}%` }} />
            </div>
        </div>
    );
}

// ─── Heatmap ───

export interface HeatmapProps {
    rows: string[];
    cols: string[];
    /** `values[rowIndex][colIndex]`; a missing or null cell renders empty. */
    values: (number | null | undefined)[][];
    tone?: Tone;
    /** Scale bounds (default: the data's min and max). */
    min?: number;
    max?: number;
    /** Cell text (default: the number). */
    format?: (value: number) => string;
    /** Print the value inside each cell (default on). */
    showValues?: boolean;
    legend?: boolean;
    title?: string;
}

/** 0..1 position of `value` between `min` and `max`. */
export function heatShare(value: number, min: number, max: number): number {
    if (max <= min) {
        return 1;
    }

    return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

/** Cell fill for a 0..1 share: `color` mixed into the panel from 8% up to `maxPercent` (default 100). */
export function heatCellBackground(color: string, share: number, maxPercent = 100): string {
    return `color-mix(in srgb, ${color} ${Math.round(8 + share * (maxPercent - 8))}%, var(--panel))`;
}

/** Grid heatmap: rows x columns of numbers shaded on one tone (hour x weekday, service x day, …). */
export function Heatmap({
    rows,
    cols,
    values,
    tone = "info",
    min,
    max,
    format,
    showValues = true,
    legend = true,
    title,
}: HeatmapProps) {
    const flat = values.flat().filter((v): v is number => typeof v === "number");
    const lo = min ?? (flat.length > 0 ? Math.min(...flat) : 0);
    const hi = max ?? (flat.length > 0 ? Math.max(...flat) : 1);
    const color = TONE_COLOR[tone];
    const fmt = format ?? ((v: number): string => String(v));

    return (
        <div className="my-3">
            {title ? <div className="mb-1 text-xs uppercase tracking-wide text-dim">{title}</div> : null}
            <div className="overflow-x-auto">
                <table className="border-separate border-spacing-0.5 font-mono text-[0.72rem]">
                    <thead>
                        <tr>
                            <th />
                            {cols.map((col, c) => (
                                <th key={`${c}-${col}`} className="px-1 pb-1 font-normal text-dim">
                                    {col}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row, r) => (
                            // The index is in every key: two rows or two columns may share a label.
                            <tr key={`${r}-${row}`}>
                                <th className="pr-2 text-left font-normal text-dim">{row}</th>
                                {cols.map((col, c) => {
                                    const value = values[r]?.[c];

                                    if (typeof value !== "number") {
                                        return (
                                            <td
                                                key={`${c}-${col}`}
                                                className="h-7 min-w-8 rounded bg-panel/40"
                                                title={`${row} / ${col}: no data`}
                                            />
                                        );
                                    }

                                    const share = heatShare(value, lo, hi);

                                    return (
                                        <td
                                            key={`${c}-${col}`}
                                            title={`${row} / ${col}: ${fmt(value)}`}
                                            className="h-7 min-w-8 rounded px-1 text-center"
                                            style={{
                                                background: heatCellBackground(color, share),
                                                color: share > 0.55 ? "var(--bg)" : "var(--text)",
                                            }}
                                        >
                                            {showValues ? fmt(value) : ""}
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {legend ? (
                <div className="mt-1.5 flex items-center gap-2 font-mono text-[0.68rem] text-dim">
                    <span>{fmt(lo)}</span>
                    <span
                        aria-hidden="true"
                        className="h-2 w-24 rounded"
                        style={{
                            background: `linear-gradient(to right, ${heatCellBackground(color, 0)}, ${heatCellBackground(color, 1)})`,
                        }}
                    />
                    <span>{fmt(hi)}</span>
                </div>
            ) : null}
        </div>
    );
}

// ─── CapacityGrid ───

export interface CapacityRow {
    label: string;
    /** Any CSS color, drawn as a swatch before the label. */
    color?: string;
    /** Load per column. null means no data. */
    load: Array<number | null>;
    /** One number for every column, or one per column (holidays, part-time). */
    capacity: number | Array<number | null>;
}

export type CapacityStatus = "idle" | "ok" | "full" | "over";

export interface CapacityGridProps {
    cols: Array<string | { label: string; title?: string }>;
    rows: CapacityRow[];
    /** Unit shown in the tooltip and the hidden text, for example "h". */
    unit?: string;
    /** Cell text. Default: one decimal, "·" for zero. */
    format?: (load: number, capacity: number) => string;
    /** Load share at or above which a cell counts as full. Default 1. */
    fullAt?: number;
    /** Shade cells by load share. Default true. */
    heat?: boolean;
    /** Add a total column and a total row. */
    totals?: boolean;
    title?: string;
}

/** Idle at zero load, over above the capacity, full at `fullAt` of it or more, ok otherwise. */
export function capacityStatus(load: number, capacity: number, fullAt = 1): CapacityStatus {
    if (load <= 0) {
        return "idle";
    }

    if (capacity <= 0 || load > capacity) {
        return "over";
    }

    return load / capacity >= fullAt ? "full" : "ok";
}

function capacityAt(row: CapacityRow, col: number): number | null {
    return Array.isArray(row.capacity) ? (row.capacity[col] ?? null) : row.capacity;
}

function defaultCapacityFormat(load: number): string {
    return load === 0 ? "·" : load.toFixed(1);
}

function trimNumber(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

interface CapacityCellProps {
    row: CapacityRow;
    colLabel: string;
    load: number | null;
    capacity: number | null;
    unit: string;
    format: (load: number, capacity: number) => string;
    fullAt: number;
    heat: boolean;
}

function CapacityCell({ row, colLabel, load, capacity, unit, format, fullAt, heat }: CapacityCellProps) {
    const suffix = unit ? ` ${unit}` : "";
    const pct = load !== null && capacity ? ` (${Math.round((load / capacity) * 100)}%)` : "";
    const description =
        load === null
            ? `${row.label}, ${colLabel}: no data`
            : `${row.label}, ${colLabel}: ${load.toFixed(1)}${suffix} of ${capacity === null ? "?" : trimNumber(capacity)}${suffix}${pct}`;
    const tip = useTooltip(description);
    const base = "rounded px-1.5 py-[3px] text-center tabular-nums";

    if (load === null) {
        return <td className={base} aria-label={description} tabIndex={0} {...tip} />;
    }

    const status: CapacityStatus =
        capacity === null ? (load > 0 ? "ok" : "idle") : capacityStatus(load, capacity, fullAt);
    const share = capacity ? Math.min(load / capacity, 1) : 0;
    const style: CSSProperties =
        status === "idle"
            ? { background: "var(--wash)" }
            : heat
              ? { background: heatCellBackground("var(--info)", share, 68) }
              : {};

    if (status === "over") {
        style.outline = "1.5px solid var(--err)";
        style.outlineOffset = "-1.5px";
    }

    return (
        <td
            data-status={status}
            aria-label={description}
            tabIndex={0}
            className={`${base} ${status === "over" ? "font-bold text-err" : status === "full" ? "font-bold text-ink" : status === "idle" ? "text-dim" : "text-ink"}`}
            style={style}
            {...tip}
        >
            {format(load, capacity ?? 0)}
            {status === "over" && capacity !== null ? (
                <span className="sr-only">{` over capacity by ${trimNumber(load - capacity)}${suffix}`}</span>
            ) : null}
        </td>
    );
}

/**
 * Load against capacity per row (a person, a role) and column (a sprint).
 * Over-capacity cells get an inset outline, bold err text and a hidden
 * sentence, so colour is never the only cue and the grid never shifts.
 */
export function CapacityGrid({
    cols,
    rows,
    unit = "",
    format = defaultCapacityFormat,
    fullAt = 1,
    heat = true,
    totals = false,
    title,
}: CapacityGridProps) {
    const titleId = useId();
    const columns = cols.map((col) => (typeof col === "string" ? { label: col } : col));
    const sum = (values: Array<number | null>): number =>
        values.reduce<number>((acc, v) => acc + (typeof v === "number" ? v : 0), 0);
    const colTotals = columns.map((_, c) => sum(rows.map((row) => row.load[c] ?? null)));
    const totalCell = "px-1.5 py-[3px] text-center font-mono tabular-nums text-dim";

    return (
        <div className="my-3">
            {title ? (
                <div id={titleId} className="mb-1 text-xs text-dim">
                    {title}
                </div>
            ) : null}
            <div className="overflow-x-auto">
                <table
                    aria-labelledby={title ? titleId : undefined}
                    className="w-full table-fixed border-separate border-spacing-0.5 text-xs"
                    style={{ minWidth: 130 + (columns.length + (totals ? 1 : 0)) * 36 }}
                >
                    <colgroup>
                        <col style={{ width: 130 }} />
                        {columns.map((col, c) => (
                            <col key={`${c}-${col.label}`} />
                        ))}
                        {totals ? <col /> : null}
                    </colgroup>
                    <thead>
                        <tr>
                            <th scope="col" className="sr-only">
                                Row
                            </th>
                            {columns.map((col, c) => (
                                <th
                                    key={`${c}-${col.label}`}
                                    scope="col"
                                    title={col.title}
                                    className="pb-1 text-center text-[11px] font-normal text-dim tabular-nums"
                                >
                                    {col.label}
                                </th>
                            ))}
                            {totals ? (
                                <th scope="col" className="pb-1 text-center text-[11px] font-normal text-dim">
                                    Total
                                </th>
                            ) : null}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row, r) => (
                            <tr key={`${r}-${row.label}`}>
                                <th scope="row" className="truncate pr-2 text-left font-semibold text-ink">
                                    <span className="inline-flex max-w-full items-center gap-1.5">
                                        {row.color ? (
                                            <span
                                                aria-hidden="true"
                                                className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                                                style={{ background: row.color }}
                                            />
                                        ) : null}
                                        <span className="truncate">{row.label}</span>
                                    </span>
                                </th>
                                {columns.map((col, c) => (
                                    <CapacityCell
                                        key={`${c}-${col.label}`}
                                        row={row}
                                        colLabel={col.label}
                                        load={row.load[c] ?? null}
                                        capacity={capacityAt(row, c)}
                                        unit={unit}
                                        format={format}
                                        fullAt={fullAt}
                                        heat={heat}
                                    />
                                ))}
                                {totals ? (
                                    <td data-total="row" className={totalCell}>
                                        {trimNumber(sum(row.load))}
                                    </td>
                                ) : null}
                            </tr>
                        ))}
                        {totals ? (
                            <tr>
                                <th scope="row" className="pr-2 text-left font-semibold text-dim">
                                    Total
                                </th>
                                {colTotals.map((total, c) => (
                                    <td key={`total-${c}`} data-total="col" className={totalCell}>
                                        {trimNumber(total)}
                                    </td>
                                ))}
                                <td data-total="all" className={`${totalCell} font-semibold text-ink`}>
                                    {trimNumber(sum(colTotals))}
                                </td>
                            </tr>
                        ) : null}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
