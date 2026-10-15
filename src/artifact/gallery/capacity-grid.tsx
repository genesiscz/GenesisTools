import { CapacityGrid, SERIES_COLOR } from "@artifact/kit";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";

export const meta: GalleryMeta = {
    family: "Planning",
    title: "Capacity grid",
    summary:
        "Load against capacity per role and sprint. Over-capacity cells get an inset outline and a hidden sentence.",
    components: ["CapacityGrid"],
};

const COLS = Array.from({ length: 8 }, (_, i) => ({ label: `S${i + 1}`, title: `Sprint ${i + 1}` }));

export default function CapacityGridPage() {
    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="Not interactive. Each cell has a tooltip on hover; an over cell says 'over capacity by 2 h' to a screen reader."
        >
            <Demo title="Hours per sprint, with totals">
                <CapacityGrid
                    unit="h"
                    totals
                    cols={COLS}
                    rows={[
                        {
                            label: "Backend",
                            color: SERIES_COLOR[2],
                            capacity: 60,
                            load: [40, 58, 60, 66, 52, 30, 0, 12],
                        },
                        { label: "Web", color: SERIES_COLOR[3], capacity: 60, load: [10, 24, 48, 61, 60, 44, 20, 8] },
                        { label: "Mobile", color: SERIES_COLOR[4], capacity: 30, load: [0, 0, 12, 28, 30, 34, 30, 16] },
                        {
                            label: "Testing",
                            color: SERIES_COLOR[0],
                            capacity: 45,
                            load: [5, 10, 20, 30, 45, 50, 40, 30],
                        },
                    ]}
                />
            </Demo>
            <Demo title="Edge case: per-sprint capacity and missing data" note="a holiday halves S4; null is empty">
                <CapacityGrid
                    unit="h"
                    cols={COLS.slice(0, 6)}
                    rows={[
                        { label: "Design", capacity: [30, 30, 30, 15, 30, 30], load: [20, 25, null, 18, 30, 0] },
                        { label: "Data", capacity: 20, load: [null, null, 10, 20, 22, 5] },
                    ]}
                />
            </Demo>
        </GalleryPage>
    );
}
