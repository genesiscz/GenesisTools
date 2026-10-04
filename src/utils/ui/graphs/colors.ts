// CSS variables with the neon hex as fallback: a dashboard theme (`.gold-bento`) can re-tune every
// chart and accent bar by setting `--gt-chart-*`, and without a theme the values stay as they were.
const cyan = "var(--gt-chart-cyan, #22d3ee)";
const amber = "var(--gt-chart-amber, #f59e0b)";
const emerald = "var(--gt-chart-emerald, #10b981)";
const violet = "var(--gt-chart-violet, #8b5cf6)";
const rose = "var(--gt-chart-rose, #fb7185)";
const soft = (color: string) => `color-mix(in srgb, ${color} 18%, transparent)`;

export const chartColors = {
    cyan,
    cyanSoft: soft(cyan),
    amber,
    amberSoft: soft(amber),
    emerald,
    emeraldSoft: soft(emerald),
    violet,
    violetSoft: soft(violet),
    rose,
    roseSoft: soft(rose),
    slate: "var(--gt-chart-slate, #94a3b8)",
    grid: "var(--gt-chart-grid, rgba(148, 163, 184, 0.16))",
    axis: "var(--gt-chart-axis, #cbd5e1)",
    tooltipBorder: "var(--gt-chart-tooltip-border, rgba(34, 211, 238, 0.25))",
    tooltipBg: "var(--gt-chart-tooltip-bg, rgba(15, 23, 42, 0.96))",
} as const;

export const chartSeriesPalette = [
    chartColors.cyan,
    chartColors.amber,
    chartColors.emerald,
    chartColors.violet,
    chartColors.rose,
] as const;
