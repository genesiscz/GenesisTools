import { Chart, type ChartConfiguration, registerables } from "chart.js";
import { useEffect, useRef } from "react";

export type { ChartConfiguration } from "chart.js";

/**
 * Escape hatch to raw Chart.js (the library the pre-kit dashboards used):
 * pass a full Chart.js v4 `config` and get the canvas, lifecycle-managed.
 * Prefer `DayChart`/`DonutChart` for the common shapes — they follow the
 * theme tokens; this wrapper only seeds readable dark-theme defaults once.
 */

Chart.register(...registerables);

let defaultsSeeded = false;

function seedDefaults(): void {
    if (defaultsSeeded || typeof window === "undefined") {
        return;
    }

    const css = getComputedStyle(document.documentElement);
    const dim = css.getPropertyValue("--dim").trim();
    const border = css.getPropertyValue("--border").trim();

    if (dim) {
        Chart.defaults.color = dim;
    }

    if (border) {
        Chart.defaults.borderColor = border;
    }

    defaultsSeeded = true;
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

    useEffect(() => {
        if (!canvasRef.current) {
            return;
        }

        seedDefaults();
        const chart = new Chart(canvasRef.current, configRef.current);
        chartRef.current = chart;
        appliedRef.current = configRef.current;

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
        chart.options = config.options ?? {};
        chart.update();
    }, [config]);

    return (
        <div className="relative" style={{ height }}>
            <canvas ref={canvasRef} role="img" aria-label={ariaLabel ?? `${config.type} chart`} />
        </div>
    );
}
