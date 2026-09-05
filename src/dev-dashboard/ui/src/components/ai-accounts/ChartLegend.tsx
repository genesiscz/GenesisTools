export interface ChartLegendItem {
    id: string;
    label: string;
    color: string;
    /** SVG `strokeDasharray`, so a legend line matches the line it names. */
    dash?: string;
}

interface ChartLegendProps {
    items: readonly ChartLegendItem[];
    /** `line` draws a stroke sample, `area` a filled swatch. */
    variant?: "line" | "area";
}

/**
 * Legend for the charts on this page, rendered in normal flow BELOW the plot.
 *
 * recharts' own `<Legend>` lives inside the chart box: with 32 limit series it
 * ate 180 of the 256 available pixels and left a 36 px plot, and at 420 px wide
 * it grew taller than the box, escaped upward as an absolutely positioned
 * element and painted over the panel above (sweep 2026-09-04, defect 5). A
 * flow-positioned list cannot overlap anything, and it scrolls once it is tall.
 */
export function ChartLegend({ items, variant = "line" }: ChartLegendProps) {
    if (items.length === 0) {
        return null;
    }

    return (
        <ul className="mt-3 flex max-h-24 flex-wrap items-center gap-x-4 gap-y-1 overflow-y-auto pr-1">
            {items.map((item) => (
                <li
                    key={item.id}
                    className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--dd-text-secondary)]"
                    title={item.label}
                >
                    {variant === "area" ? (
                        <span
                            aria-hidden="true"
                            className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                            style={{ background: item.color, opacity: 0.75 }}
                        />
                    ) : (
                        <svg aria-hidden="true" width="16" height="8" className="shrink-0">
                            <line
                                x1="0"
                                y1="4"
                                x2="16"
                                y2="4"
                                stroke={item.color}
                                strokeWidth="2"
                                strokeDasharray={item.dash}
                            />
                        </svg>
                    )}
                    <span className="max-w-[16rem] truncate">{item.label}</span>
                </li>
            ))}
        </ul>
    );
}
