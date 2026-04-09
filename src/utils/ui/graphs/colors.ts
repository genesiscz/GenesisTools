export const chartColors = {
    cyan: "#22d3ee",
    cyanSoft: "rgba(34, 211, 238, 0.18)",
    amber: "#f59e0b",
    amberSoft: "rgba(245, 158, 11, 0.18)",
    emerald: "#10b981",
    emeraldSoft: "rgba(16, 185, 129, 0.18)",
    violet: "#8b5cf6",
    violetSoft: "rgba(139, 92, 246, 0.18)",
    rose: "#fb7185",
    roseSoft: "rgba(251, 113, 133, 0.18)",
    slate: "#94a3b8",
    grid: "rgba(148, 163, 184, 0.16)",
    axis: "#cbd5e1",
    tooltipBorder: "rgba(34, 211, 238, 0.25)",
    tooltipBg: "rgba(15, 23, 42, 0.96)",
} as const;

export const chartSeriesPalette = [
    chartColors.cyan,
    chartColors.amber,
    chartColors.emerald,
    chartColors.violet,
    chartColors.rose,
] as const;
