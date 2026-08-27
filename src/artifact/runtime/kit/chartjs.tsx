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
}

/** Render a raw Chart.js chart. The chart is destroyed on unmount and rebuilt when `config` changes. */
export function ChartJs({ config, height = 320 }: ChartJsProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        if (!canvasRef.current) {
            return;
        }

        seedDefaults();
        const chart = new Chart(canvasRef.current, config);

        return () => chart.destroy();
    }, [config]);

    return (
        <div className="relative" style={{ height }}>
            <canvas ref={canvasRef} />
        </div>
    );
}
