import asciichart from "asciichart";

export type ChartMode = "line" | "bar" | "sparkline";
export const CHART_MODES: ChartMode[] = ["line", "bar", "sparkline"];
export const CHART_MODE_LABELS: Record<ChartMode, string> = {
    line: "Line chart",
    bar: "Bar chart",
    sparkline: "Sparkline",
};

export interface ChartSeries {
    label: string;
    values: number[];
    color: string;
    inkColor: string;
}

export interface ChartData {
    series: ChartSeries[];
    maxValue: number;
    chartWidth: number;
}

// ── Line chart (asciichart) ──────────────────────────────────────

export function renderLineChart(data: ChartData): string | null {
    if (data.series.length === 0) {
        return null;
    }

    const ceilMax = Math.min(100, Math.ceil(data.maxValue / 10) * 10 + 5);

    try {
        const allValues = data.series.map((s) => s.values);
        const colors = data.series.map((s) => s.color);

        return asciichart.plot(allValues.length === 1 ? allValues[0] : allValues, {
            height: 8,
            min: 0,
            max: ceilMax,
            colors: allValues.length > 1 ? colors : undefined,
            format: (v: number) => `${Math.round(v).toString().padStart(3)}%`,
        });
    } catch {
        return null;
    }
}

// ── Bar chart ────────────────────────────────────────────────────

const BAR_FULL = "\u2588";
const BAR_HALF = "\u258C";

export function renderBarChart(data: ChartData): string | null {
    if (data.series.length === 0) {
        return null;
    }

    const ceilMax = Math.min(100, Math.ceil(data.maxValue / 10) * 10 + 5);
    const barWidth = Math.max(10, data.chartWidth - 20);
    const lines: string[] = [];

    for (const series of data.series) {
        const latest = series.values[series.values.length - 1] ?? 0;
        const filled = Math.floor((latest / ceilMax) * barWidth);
        const hasHalf = latest > 0 && filled < barWidth && ((latest / ceilMax) * barWidth) % 1 >= 0.25;
        const empty = barWidth - filled - (hasHalf ? 1 : 0);

        const bar =
            series.color +
            BAR_FULL.repeat(filled) +
            (hasHalf ? BAR_HALF : "") +
            "\x1b[0m" +
            "\x1b[2m" + "\u2591".repeat(empty) + "\x1b[0m";

        lines.push(`${series.label.padEnd(16)} ${bar}  ${Math.round(latest)}%`);

        // Mini history: show last N values as a trend line
        const historyLen = Math.min(series.values.length, barWidth);
        const history = series.values.slice(-historyLen);
        const sparkChars = ["\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"];

        if (history.length >= 2) {
            const sparkline = history
                .map((v) => {
                    const idx = Math.min(
                        Math.floor((v / ceilMax) * (sparkChars.length - 1)),
                        sparkChars.length - 1
                    );
                    return sparkChars[Math.max(0, idx)];
                })
                .join("");
            lines.push(`${"".padEnd(16)} ${series.color}${sparkline}\x1b[0m`);
        }

        lines.push("");
    }

    return lines.join("\n");
}

// ── Sparkline chart ──────────────────────────────────────────────

const SPARK_CHARS = ["\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"];

export function renderSparklineChart(data: ChartData): string | null {
    if (data.series.length === 0) {
        return null;
    }

    const ceilMax = Math.min(100, Math.ceil(data.maxValue / 10) * 10 + 5);
    const sparkWidth = Math.max(10, data.chartWidth - 25);
    const lines: string[] = [];

    for (const series of data.series) {
        const display = series.values.slice(-sparkWidth);
        const latest = series.values[series.values.length - 1] ?? 0;

        const sparkline = display
            .map((v) => {
                const idx = Math.min(
                    Math.floor((v / ceilMax) * (SPARK_CHARS.length - 1)),
                    SPARK_CHARS.length - 1
                );
                return SPARK_CHARS[Math.max(0, idx)];
            })
            .join("");

        lines.push(
            `${series.label.padEnd(16)} ${series.color}${sparkline}\x1b[0m  ${Math.round(latest)}%`
        );
    }

    return lines.join("\n");
}

// ── Dispatcher ───────────────────────────────────────────────────

export function renderChart(mode: ChartMode, data: ChartData): string | null {
    switch (mode) {
        case "line":
            return renderLineChart(data);
        case "bar":
            return renderBarChart(data);
        case "sparkline":
            return renderSparklineChart(data);
    }
}
