import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { ChartConfiguration } from "chart.js";

interface ChartCall {
    type: string;
    updates: number;
    destroyed: boolean;
}

const calls: ChartCall[] = [];

class FakeChart {
    config: { type: string; data: unknown; options: unknown };
    data: unknown;
    options: unknown;
    private readonly record: ChartCall;

    constructor(_canvas: unknown, config: ChartConfiguration) {
        this.config = { type: config.type, data: config.data, options: config.options };
        this.data = config.data;
        this.options = config.options;
        this.record = { type: config.type, updates: 0, destroyed: false };
        calls.push(this.record);
    }

    update(): void {
        this.record.updates += 1;
    }

    destroy(): void {
        this.record.destroyed = true;
    }

    static register(): void {}
    static defaults: Record<string, unknown> = {};
}

mock.module("chart.js", () => ({ Chart: FakeChart, registerables: [], default: FakeChart }));

// Imported after the module mock so the component binds to FakeChart.
let ChartJs: typeof import("./chartjs").ChartJs;
let mountDom: typeof import("./test-dom").mountDom;

beforeAll(async () => {
    ChartJs = (await import("./chartjs")).ChartJs;
    mountDom = (await import("./test-dom")).mountDom;
});

function barConfig(values: number[]): ChartConfiguration {
    return {
        type: "bar",
        data: { labels: values.map(String), datasets: [{ label: "v", data: values }] },
        options: {},
    } as ChartConfiguration;
}

describe("ChartJs", () => {
    test("a new config object of the same type UPDATES the chart instead of rebuilding it", async () => {
        calls.length = 0;
        const dom = await mountDom(<ChartJs config={barConfig([1, 2])} />);

        expect(calls).toHaveLength(1);
        expect(calls[0].updates).toBe(0);

        // A fresh inline object, exactly what a re-rendering parent passes.
        await dom.render(<ChartJs config={barConfig([1, 2, 3])} />);

        expect(calls).toHaveLength(1);
        expect(calls[0].destroyed).toBe(false);
        expect(calls[0].updates).toBe(1);

        await dom.unmount();
        expect(calls[0].destroyed).toBe(true);
    });

    test("a different chart TYPE rebuilds, because Chart.js cannot switch it live", async () => {
        calls.length = 0;
        const dom = await mountDom(<ChartJs config={barConfig([1, 2])} />);
        const line = { ...barConfig([1, 2]), type: "line" } as ChartConfiguration;
        await dom.render(<ChartJs config={line} />);

        expect(calls.map((c) => c.type)).toEqual(["bar", "line"]);
        expect(calls[0].destroyed).toBe(true);
        // The rebuild already carries the new config; no redundant update() follows.
        expect(calls[1].updates).toBe(0);

        await dom.unmount();
    });

    test("the canvas carries an accessible name", async () => {
        calls.length = 0;
        const dom = await mountDom(<ChartJs config={barConfig([1])} />);
        expect(dom.html()).toContain('role="img"');
        expect(dom.html()).toContain('aria-label="bar chart"');

        await dom.render(<ChartJs config={barConfig([1])} ariaLabel="requests per day" />);
        expect(dom.html()).toContain('aria-label="requests per day"');

        await dom.unmount();
    });
});
