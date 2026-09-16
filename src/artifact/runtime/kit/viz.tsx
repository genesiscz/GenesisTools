import { TONE_COLOR } from "./charts";
import { TONE_DOT, TONE_TEXT, type Tone } from "./primitives";

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

function cellBackground(color: string, share: number): string {
    return `color-mix(in srgb, ${color} ${Math.round(8 + share * 92)}%, var(--panel))`;
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
                            {cols.map((col) => (
                                <th key={col} className="px-1 pb-1 font-normal text-dim">
                                    {col}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row, r) => (
                            <tr key={row}>
                                <th className="pr-2 text-left font-normal text-dim">{row}</th>
                                {cols.map((col, c) => {
                                    const value = values[r]?.[c];

                                    if (typeof value !== "number") {
                                        return (
                                            <td
                                                key={col}
                                                className="h-7 min-w-8 rounded bg-panel/40"
                                                title={`${row} / ${col}: no data`}
                                            />
                                        );
                                    }

                                    const share = heatShare(value, lo, hi);

                                    return (
                                        <td
                                            key={col}
                                            title={`${row} / ${col}: ${fmt(value)}`}
                                            className="h-7 min-w-8 rounded px-1 text-center"
                                            style={{
                                                background: cellBackground(color, share),
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
                            background: `linear-gradient(to right, ${cellBackground(color, 0)}, ${cellBackground(color, 1)})`,
                        }}
                    />
                    <span>{fmt(hi)}</span>
                </div>
            ) : null}
        </div>
    );
}
