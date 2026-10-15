import { DataTable, Heatmap, Meter, Sparkline } from "@artifact/kit";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";

export const meta: GalleryMeta = {
    family: "Viz",
    title: "Sparklines, meters and heatmaps",
    summary:
        "Small dependency-free visuals that sit inside other components: a trend glyph, a bar with thresholds and a grid heatmap.",
    components: ["Sparkline", "Meter", "Heatmap"],
};

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HOURS = ["00", "03", "06", "09", "12", "15", "18", "21"];
const LOAD = DAYS.map((_, d) => HOURS.map((_, h) => Math.round(((d * 5 + h * 11) % 23) + (h >= 3 && h <= 6 ? 20 : 0))));

export default function VizPage() {
    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="Not interactive. Each visual carries an accessible name or a text value, so a screen reader hears the number rather than a shape."
        >
            <Demo title="Sparkline in table cells" note="line and bar kinds, tone and raw colour">
                <DataTable
                    columns={[
                        { key: "service", label: "Service" },
                        { key: "trend", label: "Last 14 days" },
                        { key: "now", label: "Now", mono: true },
                    ]}
                    rows={[
                        {
                            service: "Checkout",
                            trend: (
                                <Sparkline
                                    values={[4, 6, 5, 8, 7, 9, 12, 10, 11, 13, 12, 14, 15, 16]}
                                    tone="ok"
                                    ariaLabel="Checkout rising"
                                />
                            ),
                            now: "16",
                        },
                        {
                            service: "Search",
                            trend: (
                                <Sparkline
                                    values={[9, 8, 9, 7, 6, 7, 5, 6, 4, 5, 3, 4, 2, 3]}
                                    tone="err"
                                    ariaLabel="Search falling"
                                />
                            ),
                            now: "3",
                        },
                        {
                            service: "Reports",
                            trend: (
                                <Sparkline
                                    kind="bar"
                                    values={[2, 5, 3, 6, 4, 7, 5, 8, 6, 9, 7, 6, 5, 4]}
                                    color="var(--info)"
                                    ariaLabel="Reports per day"
                                />
                            ),
                            now: "4",
                        },
                    ]}
                />
            </Demo>
            <Demo title="Meter" note="thresholds pick the tone; a fixed tone wins">
                <div className="flex max-w-md flex-col gap-3">
                    <Meter label="Disk" value={42} max={100} thresholds={{ warn: 70, err: 90 }} />
                    <Meter label="Memory" value={78} max={100} thresholds={{ warn: 70, err: 90 }} />
                    <Meter label="Error budget used" value={95} max={100} thresholds={{ warn: 70, err: 90 }} />
                    <Meter label="Seats" value={18} max={25} display="18 of 25" tone="info" size="sm" />
                </div>
            </Demo>
            <Demo title="Heatmap" note="jobs per three hours, with a legend">
                <Heatmap title="Queue load" rows={DAYS} cols={HOURS} values={LOAD} legend />
            </Demo>
            <Demo title="Edge case: flat, single and missing values" note="one point, all equal, null cells">
                <div className="flex items-center gap-4">
                    <Sparkline values={[5]} ariaLabel="One point" />
                    <Sparkline values={[3, 3, 3, 3]} ariaLabel="Flat" />
                    <Meter value={0} max={10} label="Empty" />
                </div>
                <div className="mt-3">
                    <Heatmap
                        rows={["A", "B"]}
                        cols={["1", "2", "3"]}
                        values={[
                            [1, null, 3],
                            [undefined, 5, 0],
                        ]}
                        tone="warn"
                        format={(v) => `${v}%`}
                    />
                </div>
            </Demo>
        </GalleryPage>
    );
}
