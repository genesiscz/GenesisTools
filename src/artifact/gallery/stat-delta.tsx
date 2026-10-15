import { StatGrid } from "@artifact/kit";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";

export const meta: GalleryMeta = {
    title: "KPI cards with a delta",
    summary: "StatGrid with a change against a baseline, an edge accent and auto-fit columns.",
};

export default function StatDeltaPage() {
    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="Not interactive. Each delta carries a hidden sentence, so a screen reader hears 'up 8 d versus baseline 27 Jan 2027' instead of an arrow."
        >
            <Demo title="Seven cards in one row at 1280 px" note="min 170">
                <StatGrid
                    min={170}
                    stats={[
                        {
                            label: "Done",
                            value: "42.0 d",
                            delta: { value: "+6.0 d", direction: "up", good: "up", baseline: "36.0 d" },
                        },
                        {
                            label: "Remaining",
                            value: "118.5 d",
                            delta: { value: "-4.0 d", direction: "down", good: "down" },
                        },
                        {
                            label: "Scope change",
                            value: "+3.5 d",
                            delta: { value: "0 d", direction: "flat", label: "this week" },
                        },
                        {
                            label: "Forecast finish",
                            value: "4 Feb 2027",
                            tone: "err",
                            edge: "err",
                            delta: { value: "+8 d", direction: "up", good: "down", baseline: "27 Jan 2027" },
                        },
                        {
                            label: "Slack to release",
                            value: "28 d",
                            edge: "warn",
                            delta: { value: "-15 d", direction: "down", good: "up" },
                        },
                        { label: "Open risks", value: "3", delta: { value: "+1", direction: "up", good: "down" } },
                        { label: "Team", value: "6.5 FTE" },
                    ]}
                />
            </Demo>
            <Demo title="Edge case: the old props only" note="unchanged look">
                <StatGrid
                    stats={[
                        { label: "sample stat", value: "42", tone: "ok" },
                        { label: "another", value: "7/9", tone: "warn", hint: "since **Monday**" },
                    ]}
                />
            </Demo>
        </GalleryPage>
    );
}
