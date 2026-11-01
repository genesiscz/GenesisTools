import {
    Badge,
    Callout,
    Card,
    CardGrid,
    Hero,
    HUE,
    Legend,
    PageLookContext,
    Section,
    StatGrid,
    Timeline,
} from "@artifact/kit";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";

export const meta: GalleryMeta = {
    family: "Layout",
    title: "Document look",
    summary:
        'Page look="document": display headings, 16 px prose and roomier cards for a design document. The same components, one prop on Page.',
    components: [
        "Page",
        "Hero",
        "Section",
        "StatGrid",
        "Card",
        "CardGrid",
        "Legend",
        "Badge",
        "Callout",
        "Timeline",
        "HUE",
    ],
};

const STEPS = [
    {
        time: "A1",
        title: "Store and contract",
        badge: "M",
        aside: "R1 R3",
        body: "The shared parser and the first JSON door.",
        color: HUE.teal,
        group: "Foundations first",
        highlight: true,
    },
    {
        time: "A2",
        title: "Migration",
        badge: "S",
        aside: "R2",
        body: "One loader migration; readers accept the old shape.",
        color: HUE.teal,
        group: "Foundations first",
    },
    {
        time: "B1",
        title: "Window",
        badge: "L",
        aside: "R1 R4",
        body: "The native window reads the finished door.",
        color: HUE.rose,
        group: "Interface on top",
    },
];

export default function DocumentLookPage() {
    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="Nothing here takes focus except links and buttons inside the cards. Hover lifts and tilts are pointer-only extras; the content reads the same without them, and reduced motion keeps every card still."
        >
            <PageLookContext.Provider value="document">
                <Demo title="Hero with a highlighted phrase and stats with coloured edges">
                    <Hero
                        kicker="Design note · 2026-11-01"
                        title="One store, one core, doors first"
                        highlight="doors first"
                        subtitle="The `highlight` phrase gets the accent gradient. A `→` in a stat value is drawn dim."
                    >
                        <StatGrid
                            min={200}
                            stats={[
                                { value: "5→1", label: "entry points for one question", color: HUE.sky },
                                { value: "3→1", label: "time-window grammars", color: HUE.teal },
                                { value: "12 / 14", label: "items with a library half", color: HUE.lime },
                            ]}
                        />
                    </Hero>
                </Demo>
                <Section
                    id="doc-section"
                    number="01"
                    title="A numbered section with an intro"
                    intro="The intro is markdown in `--text-2`. The `id` makes the section a TopNav target."
                >
                    <Legend
                        items={[
                            {
                                mark: (
                                    <Badge tag color={HUE.rose}>
                                        dup
                                    </Badge>
                                ),
                                text: "two names for one thing",
                            },
                            {
                                mark: (
                                    <Badge tag dashed>
                                        proposed
                                    </Badge>
                                ),
                                text: "not built yet",
                            },
                            { swatch: HUE.sky, text: "a colour swatch" },
                            { swatch: HUE.slate, dashed: true, text: "a dashed swatch" },
                        ]}
                    />
                    <CardGrid min={240} fill>
                        <Card
                            mono
                            tilt={-1.2}
                            color={HUE.rose}
                            title="tools old usage"
                            subtitle="a scattered command"
                            lines={[
                                <>
                                    --json <Badge tag>machine readers</Badge>
                                </>,
                                "--watch · --token",
                            ]}
                        />
                        <Card
                            mono
                            tilt={1}
                            color={HUE.sky}
                            title="tools new usage"
                            subtitle="the new root"
                            lines={["limits · spend · sessions"]}
                        />
                        <Card
                            mono
                            dashed
                            edge="top"
                            tilt={-0.6}
                            title="+ new verbs"
                            subtitle="proposed"
                            lines={[
                                <>
                                    <Badge tag dashed>
                                        series
                                    </Badge>{" "}
                                    <Badge tag dashed>
                                        alerts
                                    </Badge>
                                </>,
                            ]}
                        />
                    </CardGrid>
                </Section>
                <Demo
                    title="A card with a number, fields, a note and a footer of tags"
                    note="edge bottom, lift on hover"
                >
                    <CardGrid min={300} fill>
                        <Card
                            number={1}
                            title="Usage window"
                            color={HUE.sky}
                            edge="bottom"
                            lift
                            fields={[
                                { k: "command", v: "`limits series`" },
                                { k: "module", v: "limits/ series modes" },
                                { k: "store", v: "usage_snapshots" },
                            ]}
                            note="Reader half shipped last week."
                            footer={
                                <>
                                    <Badge tag color={HUE.teal}>
                                        A1 library
                                    </Badge>
                                    <Badge tag color={HUE.rose}>
                                        B1 UI
                                    </Badge>
                                </>
                            }
                        />
                        <Card number={2} title="Edge case: no fields, no footer" color={HUE.amber} edge="bottom">
                            A card with only a body still keeps the number and the edge.
                        </Card>
                    </CardGrid>
                </Demo>
                <Demo title="Kicker cards, muted cards and a bar callout">
                    <Callout bar color={HUE.teal}>
                        {"**Where a new verb goes.** A bar callout is a rule note: a left bar and a faint tint."}
                    </Callout>
                    <CardGrid min={220}>
                        <Card kicker="phase 1" color={HUE.teal} title="With each move">
                            The old path forwards to the same function.
                        </Card>
                        <Card kicker="phase 2" color={HUE.amber} title="After the clients move">
                            The old path warns on a TTY only.
                        </Card>
                    </CardGrid>
                    <CardGrid min={220}>
                        <Card muted title="Code">
                            A codemod per area, with shims for one release.
                        </Card>
                        <Card muted title="Stores">
                            New migration entries; no history table is touched.
                        </Card>
                    </CardGrid>
                </Demo>
                <Demo
                    title="Timeline in the document look"
                    note="group headings, a badge, an aside, highlighted first step"
                >
                    <Timeline asideColor={HUE.teal} entries={STEPS} />
                </Demo>
            </PageLookContext.Provider>
        </GalleryPage>
    );
}
