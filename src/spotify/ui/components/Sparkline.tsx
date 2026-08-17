/**
 * Inline sparkline. Recharts is too heavy to mount once per table row, so this is a plain
 * SVG polyline — the same information the terminal's `▁▂▃▅▇` column carries.
 */
export function Sparkline({
    values,
    width = 96,
    height = 20,
    color = "var(--chart-1)",
}: {
    values: number[];
    width?: number;
    height?: number;
    color?: string;
}) {
    if (values.length < 2) {
        return <div style={{ width, height }} />;
    }

    const max = Math.max(...values);
    const min = Math.min(...values);
    const span = max - min || 1;
    const step = width / (values.length - 1);
    const points = values
        .map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / span) * (height - 2) - 1).toFixed(1)}`)
        .join(" ");

    // Not decorative: in the rankings table this column is the only place the trend appears, so
    // it carries its own reading rather than being hidden from assistive technology.
    const label = `trend over ${values.length} buckets, ${values[0]} to ${values[values.length - 1]} plays, peak ${max}`;

    return (
        <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={label}
            className="block"
        >
            <title>{label}</title>
            <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
        </svg>
    );
}

/** A labelled score row: name on the left, what it measures on the right, bar underneath. */
export function ScoreRow({ label, value, hint }: { label: string; value: number; hint: string }) {
    return (
        <div>
            <div className="flex items-baseline justify-between mb-1">
                <span className="text-xs font-mono uppercase tracking-widest text-muted-foreground">{label}</span>
                <span className="text-xs text-muted-foreground">{hint}</span>
            </div>
            <ScoreBar value={value} />
        </div>
    );
}

/**
 * Ratio drawn as a filled track plus its percentage — the score readouts.
 * `showValue={false}` for the places that already print the number in a headline.
 */
export function ScoreBar({ value, label, showValue = true }: { value: number; label?: string; showValue?: boolean }) {
    const ratio = Math.max(0, Math.min(1, value));
    const color = ratio >= 0.66 ? "var(--chart-3)" : ratio >= 0.33 ? "var(--chart-4)" : "var(--chart-5)";

    return (
        <div className="flex items-center gap-3">
            <div className="h-2 flex-1 rounded-full bg-muted/40 overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${ratio * 100}%`, background: color }} />
            </div>
            {showValue && (
                <span className="text-xs font-mono tabular-nums" style={{ color }}>
                    {label ?? `${(ratio * 100).toFixed(1)}%`}
                </span>
            )}
        </div>
    );
}
