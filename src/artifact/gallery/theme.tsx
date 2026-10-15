import { ChartJs, Mermaid, SERIES_COLOR, ThemeToggle, useTheme } from "@artifact/kit";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";

export const meta: GalleryMeta = {
    family: "Layout",
    title: "Light and dark",
    summary:
        "The auto template follows the system. ThemeToggle is the opt-in override; charts and diagrams recolour on a flip.",
    components: ["ThemeToggle"],
};

const MONTHS = ["Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];

export default function ThemePage() {
    const { mode, resolved } = useTheme();

    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="ThemeToggle is a radio group: Tab reaches it, Space picks an option. The choice is stored and applied before the next first paint."
        >
            <Demo title="Toggle" note={`mode ${mode}, showing ${resolved}`}>
                <ThemeToggle />
            </Demo>
            <Demo title="Series colours" note="SERIES_COLOR, eight light and dark pairs">
                <div className="flex flex-wrap gap-2">
                    {SERIES_COLOR.map((color, i) => (
                        <span
                            key={color}
                            className="inline-flex h-10 w-20 items-end rounded-card p-1 font-mono text-[10px] text-white"
                            style={{ background: color }}
                        >
                            {i + 1}
                        </span>
                    ))}
                </div>
            </Demo>
            <Demo title="A Chart.js chart recolours with no reload">
                <ChartJs
                    height={220}
                    ariaLabel="Remaining effort per month"
                    config={{
                        type: "line",
                        data: {
                            labels: MONTHS,
                            datasets: [
                                {
                                    label: "Remaining days",
                                    data: [160, 141, 118, 96, 70, 31],
                                    borderColor: "#3987e5",
                                    tension: 0.3,
                                },
                            ],
                        },
                        options: { maintainAspectRatio: false },
                    }}
                />
            </Demo>
            <Demo title="Edge case: a Mermaid diagram" note="needs the network on first render">
                <Mermaid
                    chart={"flowchart LR\n  Plan --> Build --> Review --> Release\n  Review -- changes --> Build"}
                />
            </Demo>
        </GalleryPage>
    );
}
