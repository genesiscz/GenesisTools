import { HUE, SegmentBar } from "@artifact/kit";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";

export const meta: GalleryMeta = {
    family: "Viz",
    title: "Segment bar",
    summary:
        "SegmentBar: one bar cut into proportional segments, each with a short label on its own fill and a full name on hover.",
    components: ["SegmentBar"],
};

const SIZE = { S: 1, M: 2, L: 3 } as const;
const STEPS: Array<{ id: string; size: keyof typeof SIZE; name: string; ui?: boolean }> = [
    { id: "A1", size: "M", name: "Contract and the first doors" },
    { id: "A2", size: "S", name: "Availability in the store" },
    { id: "A3", size: "S", name: "Forecast in the core" },
    { id: "A4", size: "L", name: "Reader members" },
    { id: "B1", size: "L", name: "Usage window", ui: true },
    { id: "B2", size: "M", name: "Popover and settings", ui: true },
];

export default function SegmentBarPage() {
    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="Tab reaches each segment that has a title; the shared hover card shows the full name on focus as it does on hover. Screen readers hear the label and the full name."
        >
            <Demo title="A build order by size, two phases, captions at both ends">
                <SegmentBar
                    ariaLabel="Build order by size"
                    labels={["library first", "interface on top"]}
                    segments={STEPS.map((s) => ({
                        label: s.id,
                        sub: s.size,
                        weight: SIZE[s.size],
                        color: s.ui ? HUE.rose : HUE.teal,
                        title: `${s.id}: ${s.name}`,
                    }))}
                />
            </Demo>
            <Demo title="Edge case: tones, equal weights, one segment without a title">
                <SegmentBar
                    segments={[
                        { label: "done", tone: "ok", title: "Done: 12 items" },
                        { label: "late", tone: "warn", title: "Late: 3 items" },
                        { label: "open", tone: "neutral" },
                    ]}
                />
            </Demo>
        </GalleryPage>
    );
}
