import { ChartJs, DayChart, DonutChart, parseCssColor, resolveCssColor, useColorSchemeTick } from "@artifact/kit";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";

export const meta: GalleryMeta = {
    family: "Charts",
    title: "Day, donut and Chart.js charts",
    summary:
        "Theme-coloured bar and line charts over labelled buckets, a donut breakdown, and a raw Chart.js escape hatch.",
    components: ["DayChart", "DonutChart", "ChartJs"],
};

const DAYS = Array.from({ length: 14 }, (_, i) => `Oct ${i + 1}`);

function translucent(color: string): string {
    const rgb = parseCssColor(color);

    return rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.2)` : color;
}

/** Chart.js draws on a canvas, so CSS variables are resolved to colours first and again on a scheme flip. */
function SkillsRadar() {
    useColorSchemeTick();
    const a = resolveCssColor("--series-1");
    const b = resolveCssColor("--series-3");
    const grid = resolveCssColor("--border");
    const ink = resolveCssColor("--dim");

    return (
        <ChartJs
            height={300}
            ariaLabel="Team skills radar"
            config={{
                type: "radar",
                data: {
                    labels: ["Backend", "Frontend", "Ops", "Data", "Design"],
                    datasets: [
                        { label: "Team A", data: [8, 5, 7, 4, 3], borderColor: a, backgroundColor: translucent(a) },
                        { label: "Team B", data: [4, 8, 3, 6, 7], borderColor: b, backgroundColor: translucent(b) },
                    ],
                },
                options: {
                    maintainAspectRatio: false,
                    plugins: { legend: { labels: { color: ink } } },
                    scales: {
                        r: {
                            grid: { color: grid },
                            angleLines: { color: grid },
                            pointLabels: { color: ink },
                            ticks: { display: false },
                        },
                    },
                },
            }}
        />
    );
}

export default function ChartsPage() {
    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="Not interactive from the keyboard. Hover shows the values; each chart has an accessible name, and SeriesTable (Data family) is the text fallback for the same numbers."
        >
            <Demo title="DayChart" note="stacked bars, a dashed line and a marker">
                <DayChart
                    labels={DAYS}
                    yLabel="Jobs"
                    series={[
                        {
                            label: "Done",
                            values: DAYS.map((_, i) => 40 + ((i * 7) % 15)),
                            tone: "ok",
                            kind: "bar",
                            stack: true,
                        },
                        {
                            label: "Failed",
                            values: DAYS.map((_, i) => (i === 6 ? 22 : 2 + (i % 4))),
                            tone: "err",
                            kind: "bar",
                            stack: true,
                        },
                        { label: "Target", values: DAYS.map(() => 50), tone: "neutral", kind: "line", dashed: true },
                    ]}
                    markers={[{ at: "Oct 7", label: "deploy", tone: "warn" }]}
                />
            </Demo>
            <Demo title="DonutChart" note="a centre label and a side legend">
                <DonutChart
                    center="1,240"
                    ariaLabel="Tickets by status"
                    slices={[
                        { label: "Closed", value: 820, tone: "ok" },
                        { label: "Open", value: 260, tone: "info" },
                        { label: "Waiting", value: 110, tone: "warn" },
                        { label: "Escalated", value: 50, tone: "err" },
                    ]}
                />
            </Demo>
            <Demo title="ChartJs" note="any Chart.js v4 config; here a radar chart">
                <SkillsRadar />
            </Demo>
            <Demo title="Edge case: a log scale with zeros and gaps" note="zero and null points are dropped">
                <DayChart
                    labels={DAYS}
                    log
                    yLabel="Bytes"
                    height={200}
                    series={[
                        {
                            label: "Payload",
                            values: DAYS.map((_, i) => (i % 5 === 0 ? 0 : i === 3 ? null : 10 ** ((i % 6) + 1))),
                            tone: "info",
                            kind: "line",
                        },
                    ]}
                />
            </Demo>
        </GalleryPage>
    );
}
