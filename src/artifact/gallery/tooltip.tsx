import { Button, Tooltip, useTooltip } from "@artifact/kit";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";

export const meta: GalleryMeta = {
    title: "Tooltip",
    summary: "One shared dark hover card: title, subtitle, key and value rows, sections and a note.",
};

function Cell({ day, load }: { day: number; load: number }) {
    const tip = useTooltip(() => ({
        title: `Day ${day}`,
        rows: [
            { k: "Load", v: `${load} h` },
            { k: "Capacity", v: "8 h" },
        ],
        note: load > 8 ? "Over capacity" : undefined,
        noteTone: "err",
    }));

    return (
        <span
            {...tip}
            role="img"
            aria-label={`Day ${day}, ${load} hours`}
            className="inline-block h-6 w-6 rounded"
            style={{ background: `color-mix(in srgb, var(--info) ${Math.min(100, load * 9)}%, var(--panel))` }}
        />
    );
}

export default function TooltipPage() {
    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="The card shows when its target gets keyboard focus and hides on blur or Escape. It never holds focus itself."
        >
            <Demo title="Structured content">
                <Tooltip
                    content={{
                        title: "Public API, write endpoints",
                        subtitle: "Platform lane",
                        rows: [
                            { k: "Dates", v: "7 Dec to 15 Jan" },
                            { k: "Effort", v: "14.0 d" },
                            { k: "Shift", v: "+28 d", tone: "err" },
                        ],
                        sections: [
                            {
                                title: "Waiting on",
                                rows: [
                                    { k: "Data model", v: "done", tone: "ok" },
                                    { k: "Read endpoints", v: "in progress", tone: "warn" },
                                ],
                            },
                        ],
                        note: "The end moved after the review added two endpoints.",
                    }}
                >
                    <Button>Hover or focus me</Button>
                </Tooltip>
            </Demo>
            <Demo title="Edge case: 120 targets, one card" note="useTooltip spreads handlers; the card node is shared">
                <div className="flex max-w-xl flex-wrap gap-1">
                    {Array.from({ length: 120 }, (_, i) => (
                        <Cell key={i} day={i + 1} load={(i * 7) % 12} />
                    ))}
                </div>
            </Demo>
        </GalleryPage>
    );
}
