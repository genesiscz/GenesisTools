import { Chart, type ChartConfiguration, registerables } from "chart.js";
import { useEffect, useRef } from "react";

export type { ChartConfiguration } from "chart.js";

/**
 * Escape hatch to raw Chart.js (the library the pre-kit dashboards used):
 * pass a full Chart.js v4 `config` and get the canvas, lifecycle-managed.
 * Prefer `DayChart`/`DonutChart` for the common shapes; this wrapper applies
 * the same theme tokens to a raw config.
 */

Chart.register(...registerables);

interface ThemeChartColors {
    color?: string;
    borderColor?: string;
}

/**
 * Theme tokens RESOLVED to concrete colors, per chart.
 *
 * Two things force this shape. Chart.js draws to a canvas, and a canvas
 * fillStyle cannot use `var(--dim)` — it is not CSS, so the string is simply
 * dropped. That is why this cannot mirror charts.tsx, which hands `var(--ok)`
 * to Recharts and lets the SVG resolve it at paint time. And the resolved
 * values belong on the chart's OWN options rather than on `Chart.defaults`,
 * which is module-global: writing there once per process froze whichever
 * theme happened to render first, and left nothing to re-read afterwards.
 */
function themeChartColors(): ThemeChartColors {
    if (typeof window === "undefined") {
        return {};
    }

    const css = getComputedStyle(document.documentElement);
    const color = css.getPropertyValue("--dim").trim();
    const borderColor = css.getPropertyValue("--border").trim();

    return { ...(color ? { color } : {}), ...(borderColor ? { borderColor } : {}) };
}

export interface ChartJsProps {
    /** A complete Chart.js v4 configuration (type, data, options). */
    config: ChartConfiguration;
    height?: number;
    /** Accessible name for the chart image (screen readers). */
    ariaLabel?: string;
}

/**
 * Render a raw Chart.js chart. The chart is destroyed on unmount, UPDATED in
 * place when the data or options change, and rebuilt only when the chart type
 * changes (Chart.js cannot switch the type of a live chart). Callers normally
 * pass an inline `config` object, so a fresh reference arrives on every parent
 * render: rebuilding on each one would throw the canvas away on every keystroke
 * of a surrounding Simulator.
 */
export function ChartJs({ config, height = 320, ariaLabel }: ChartJsProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const chartRef = useRef<Chart | null>(null);
    // Read by the create effect, which must not re-run when only the data changes.
    const configRef = useRef(config);
    configRef.current = config;
    // The config a live chart already carries, so a rebuild is not followed by a
    // redundant update() of the very same object.
    const appliedRef = useRef<ChartConfiguration | null>(null);
    // Read once per chart, and reused by the update effect below so an update
    // cannot strip the theme back off the options.
    const themeRef = useRef<ThemeChartColors>({});

    useEffect(() => {
        if (!canvasRef.current) {
            return;
        }

        themeRef.current = themeChartColors();
        const base = configRef.current;
        // Caller options win: the theme only supplies what the config omits.
        const chart = new Chart(canvasRef.current, {
            ...base,
            options: { ...themeRef.current, ...base.options },
        });
        chartRef.current = chart;
        appliedRef.current = base;

        return () => {
            chartRef.current = null;
            chart.destroy();
        };
    }, [config.type]);

    useEffect(() => {
        const chart = chartRef.current;

        if (!chart || appliedRef.current === config) {
            return;
        }

        appliedRef.current = config;
        chart.data = config.data;
        chart.options = { ...themeRef.current, ...config.options };
        chart.update();
    }, [config]);

    return (
        <div className="relative" style={{ height }}>
            <canvas ref={canvasRef} role="img" aria-label={ariaLabel ?? `${config.type} chart`} />
        </div>
    );
}
