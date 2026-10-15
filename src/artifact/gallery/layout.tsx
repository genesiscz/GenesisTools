import { Card, CardGrid, Collapse, Hero, Page, Section, Tabs } from "@artifact/kit";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";

export const meta: GalleryMeta = {
    family: "Layout",
    title: "Page, sections and cards",
    summary: "The page shell, a hero header, labelled sections, cards in a grid, a drill-down row and tabs.",
    components: ["Page", "Hero", "Section", "Card", "CardGrid", "Collapse", "Tabs"],
};

export default function LayoutPage() {
    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="Collapse is a native details element: Tab reaches the summary row and Enter or Space opens it. Tabs is a tablist: Tab focuses the active tab, Left and Right move between tabs, Home and End jump to the ends."
        >
            <Demo title="Page and Hero" note="Page fills the viewport; here it sits in a framed box that scrolls">
                <div className="h-72 overflow-auto rounded-card border border-line">
                    <Page>
                        <Hero
                            kicker="Weekly report"
                            title="Checkout service health"
                            subtitle="Error rate fell after the **retry fix** shipped on Tuesday."
                            chips={[
                                { k: "week", v: "41" },
                                { k: "owner", v: "payments team" },
                                { k: "status", v: "stable", tone: "ok" },
                            ]}
                        />
                        <Section title="Summary" note="3 items">
                            <p className="text-dim">Sections sit under the hero and carry a title and a side note.</p>
                        </Section>
                    </Page>
                </div>
            </Demo>
            <Demo title="Cards in a grid" note="CardGrid columns 3">
                <CardGrid columns={3}>
                    <Card title="Latency">p95 is **212 ms**, down from 260 ms.</Card>
                    <Card title="Errors" tone="ok">
                        0.4% of requests, under the 1% budget.
                    </Card>
                    <Card title="Queue depth" tone="warn">
                        Peaks at 1,200 jobs every night at 02:00.
                    </Card>
                </CardGrid>
            </Demo>
            <Demo title="Collapse" note="closed by default, meta on the right">
                <div className="flex flex-col gap-2">
                    <Collapse summary="Slow endpoints" meta="4 found">
                        <p className="text-dim">/orders, /orders/:id, /refunds and /reports each crossed 500 ms.</p>
                    </Collapse>
                    <Collapse summary="Opened on load" meta="open" open>
                        <p className="text-dim">Pass open to start expanded.</p>
                    </Collapse>
                </div>
            </Demo>
            <Demo title="Tabs" note="the active tab is written to the URL hash">
                <Tabs
                    sticky={false}
                    tabs={[
                        { id: "layout-overview", label: "Overview", content: <p className="text-dim">First panel.</p> },
                        {
                            id: "layout-risks",
                            label: "Risks",
                            badge: { text: "2 open", tone: "warn" },
                            content: <p className="text-dim">Badges sit after the label.</p>,
                        },
                        { id: "layout-notes", label: "Notes", content: <p className="text-dim">Third panel.</p> },
                    ]}
                />
            </Demo>
            <Demo title="Edge case: a long title and twelve tabs" note="scroll keeps the bar on one line">
                <Card title="A card title long enough to wrap onto a second line when the column is narrow">
                    Cards keep their padding and wrap the title instead of clipping it.
                </Card>
                <div className="mt-4">
                    <Tabs
                        sticky={false}
                        scroll
                        tabs={Array.from({ length: 12 }, (_, i) => ({
                            id: `layout-month-${i + 1}`,
                            label: `Month ${i + 1}`,
                            content: <p className="text-dim">Report for month {i + 1}.</p>,
                        }))}
                    />
                </div>
            </Demo>
        </GalleryPage>
    );
}
