import { Button, Mermaid, ZoomPane } from "@artifact/kit";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";

export const meta: GalleryMeta = {
    family: "Diagrams",
    title: "Diagrams and zoom",
    summary: "Mermaid diagrams in the theme's colours, loaded on first use, and the zoom frame they sit in.",
    components: ["Mermaid", "ZoomPane"],
};

const FLOW = `flowchart LR
    A[Order placed] --> B{Payment ok?}
    B -- yes --> C[Pack]
    B -- no --> D[Retry]
    D --> B
    C --> E[Ship]`;

const SEQUENCE = `sequenceDiagram
    participant Client
    participant API
    participant Queue
    Client->>API: POST /orders
    API->>Queue: enqueue job
    Queue-->>API: accepted
    API-->>Client: 202`;

export default function DiagramsPage() {
    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="ZoomPane's toolbar buttons (zoom out, reset, zoom in, and any extra tools) are normal buttons: Tab reaches them, Enter or Space presses them. The pane scrolls with the arrow keys once focused."
        >
            <Demo title="Mermaid" note="flowchart with a caption; needs the network on first use">
                <Mermaid chart={FLOW} caption="Order flow" />
            </Demo>
            <Demo title="Mermaid without zoom" note="zoom off renders the bare SVG">
                <Mermaid chart={SEQUENCE} zoom={false} />
            </Demo>
            <Demo title="ZoomPane around any content" note="an extra tool button and a max height">
                <ZoomPane label="Floor plan zoom" maxHeight={220} tools={<Button size="sm">Extra tool</Button>}>
                    <div className="grid w-[640px] grid-cols-4 gap-2 p-3">
                        {Array.from({ length: 16 }, (_, i) => (
                            <div key={i} className="rounded-card border border-line bg-panel p-3 text-center text-sm">
                                Room {i + 1}
                            </div>
                        ))}
                    </div>
                </ZoomPane>
            </Demo>
            <Demo title="Edge case: a syntax error" note="the message shows above the source instead of a blank frame">
                <Mermaid chart={"flowchart LR\n    A --> \n    --> B"} />
            </Demo>
        </GalleryPage>
    );
}
