import { Card, DecisionBoard, type DecisionPoint, LayerDiagram, Note } from "@artifact/kit";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";

export const meta: GalleryMeta = {
    family: "Interactive",
    title: "Decision board",
    summary: "Compact sticky controls, presets and a URL-restorable combination feeding one pure result.",
    components: ["DecisionBoard", "StickyControls"],
};

const POINTS: DecisionPoint[] = [
    {
        key: "source",
        number: "1",
        title: "Read source",
        tone: "warn",
        state: "Open",
        options: [
            { value: "cache", label: "Cache" },
            { value: "live", label: "Live" },
        ],
        note: "Choose how the client reads the catalog.",
    },
    {
        key: "format",
        number: "2",
        title: "Data format",
        tone: "ok",
        locked: true,
        options: [
            { value: "object", label: "Object" },
            { value: "text", label: "Text" },
        ],
        note: "A decided point stays locked until explicitly unlocked.",
    },
    {
        key: "refresh",
        number: "3",
        title: "Refresh",
        tone: "info",
        options: [
            { value: "manual", label: "Manual" },
            {
                value: "auto",
                label: "Automatic",
                disabledWhen: (choices) => (choices.source === "live" ? "Live reads are already current" : undefined),
            },
        ],
        disabledWhen: (choices) => (choices.source === "live" ? "Refresh is unnecessary for a live read." : undefined),
    },
];

export default function DecisionBoardPage() {
    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="Tab reaches presets, expansion, copy, unlock and each radio group. Left and Right choose an available option. The hash restores choices after a reload."
        >
            <Demo
                title="Three decisions"
                note="Expand to read notes; a preset change updates the result on the same screen."
            >
                <DecisionBoard
                    points={POINTS}
                    initial={{ source: "cache", format: "object", refresh: "manual" }}
                    presets={[
                        {
                            id: "cached",
                            label: "Cached",
                            choices: { source: "cache", format: "object", refresh: "manual" },
                        },
                        {
                            id: "direct",
                            label: "Direct",
                            choices: { source: "live", format: "object", refresh: "manual" },
                        },
                    ]}
                >
                    {(choices, api) => (
                        <>
                            <LayerDiagram
                                title="Result"
                                layers={[
                                    {
                                        id: "client",
                                        label: "Client",
                                        nodes: [
                                            {
                                                id: "reader",
                                                title: "Catalog reader",
                                                lines: [`data: ${choices.format}`],
                                            },
                                        ],
                                    },
                                    {
                                        id: "source",
                                        label: "Source",
                                        nodes: [
                                            {
                                                id: "store",
                                                title: choices.source === "cache" ? "Cached snapshot" : "Live catalog",
                                                lines: [`refresh: ${choices.refresh}`],
                                            },
                                        ],
                                    },
                                ]}
                                edges={[{ from: "reader", to: "store" }]}
                            />
                            <Note>{`Changed from preset: ${api.changed.join(", ") || "none"}.`}</Note>
                        </>
                    )}
                </DecisionBoard>
            </Demo>
            <Demo title="Nested surfaces" note="A CodeBlock in a Card shares its surface; framed is still available.">
                <Card kicker="Element properties" title="Readable secondary text">
                    The kicker uses the secondary text token in both themes.
                </Card>
            </Demo>
        </GalleryPage>
    );
}
