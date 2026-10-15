// Served via `tools artifact serve <this-file>`; light and dark with `--template auto`.
// A project roadmap from one inline sample: KPI cards, lane filters, a Gantt against a baseline,
// a capacity grid and a sync ledger. Replace PLAN with your own data. Full kit API: `tools artifact kit`
import {
    CapacityGrid,
    ChangeLedger,
    Collapse,
    diffFields,
    FilterChips,
    Gantt,
    type GanttBar,
    type GanttLane,
    type GanttMilestone,
    GanttTable,
    type GanttView,
    Hero,
    type LedgerEntry,
    Page,
    SERIES_COLOR,
    Section,
    SegmentedControl,
    StatGrid,
} from "@artifact/kit";
import { useState } from "react";

const PLAN = {
    axis: { start: "2026-09-14", end: "2027-03-28" },
    today: "2026-10-14",
    lanes: [
        { id: "discovery", label: "Discovery" },
        { id: "platform", label: "Platform" },
        { id: "client", label: "Client apps" },
    ] satisfies GanttLane[],
    bars: [
        {
            id: "d1",
            lane: "discovery",
            label: "Customer interviews",
            start: "2026-09-14",
            end: "2026-09-25",
            barLabel: "6.0 d",
            progress: 1,
        },
        {
            id: "d2",
            lane: "discovery",
            label: "Problem brief",
            start: "2026-09-28",
            end: "2026-10-16",
            barLabel: "5.0 d",
            progress: 0.5,
            ghost: { start: "2026-09-28", end: "2026-10-09" },
        },
        {
            id: "p1",
            lane: "platform",
            label: "Data model",
            start: "2026-10-12",
            end: "2026-11-06",
            barLabel: "12.0 d",
            ghost: { start: "2026-09-28", end: "2026-10-23" },
        },
        {
            id: "p2",
            lane: "platform",
            label: "Read endpoints",
            start: "2026-11-09",
            end: "2026-12-04",
            barLabel: "10.0 d",
        },
        {
            id: "p3",
            lane: "platform",
            label: "Write endpoints",
            start: "2026-12-07",
            end: "2027-01-15",
            barLabel: "14.0 d",
            ghost: { start: "2026-11-23", end: "2026-12-18" },
        },
        { id: "c1", lane: "client", label: "Web shell", start: "2026-11-02", end: "2026-11-27", barLabel: "9.0 d" },
        {
            id: "c2",
            lane: "client",
            label: "Mobile screens",
            start: "2026-12-07",
            end: "2027-02-12",
            barLabel: "20.0 d",
            ghost: { start: "2026-12-07", end: "2027-01-29" },
        },
    ] satisfies GanttBar[],
    milestones: [
        { id: "beta", label: "Beta", date: "2027-01-29", ghost: "2027-01-15" },
        { id: "release", label: "Release", date: "2027-03-12", ghost: "2027-02-26" },
    ] satisfies GanttMilestone[],
    sprints: ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"],
    capacity: [
        { label: "Backend", capacity: 60, load: [40, 58, 60, 66, 52, 30, 12, 0] },
        { label: "Web", capacity: 60, load: [10, 24, 48, 61, 60, 44, 20, 8] },
        { label: "Mobile", capacity: 30, load: [0, 0, 12, 28, 30, 34, 30, 16] },
    ],
};

const LEDGER: LedgerEntry[] = [
    {
        id: "sync-2",
        time: "2026-10-14T16:20:00Z",
        title: "Sync from the issue tracker",
        tone: "warn",
        meta: [{ k: "forecast", v: "+14 d", tone: "err" }],
        items: [
            {
                id: "p1",
                label: "Data model",
                changes: diffFields({ state: "New", estimate: 10 }, { state: "Active", estimate: 12, blocked: true }),
            },
        ],
    },
    { id: "sync-1", time: "2026-10-12T09:00:00Z", title: "Baseline taken", tone: "info", changes: [] },
];

export default function Roadmap() {
    const [bars, setBars] = useState<GanttBar[]>(PLAN.bars);
    const [view, setView] = useState<GanttView>("compare");
    const [shown, setShown] = useState(PLAN.lanes.map((l) => l.id));

    return (
        <Page width="max-w-7xl">
            <Hero
                kicker="Project roadmap"
                title="{{TITLE}}"
                subtitle="Where the plan stands against its baseline. Drag a bar to try a change; nothing is saved."
            />
            <StatGrid
                min={170}
                stats={[
                    {
                        label: "Done",
                        value: "18.0 d",
                        delta: { value: "+3.0 d", direction: "up", good: "up", label: "this week" },
                    },
                    {
                        label: "Remaining",
                        value: "71.0 d",
                        delta: { value: "+2.0 d", direction: "up", good: "down", baseline: "69.0 d" },
                    },
                    {
                        label: "Forecast release",
                        value: "12 Mar 2027",
                        tone: "err",
                        edge: "err",
                        delta: { value: "+14 d", direction: "up", good: "down", baseline: "26 Feb 2027" },
                    },
                    {
                        label: "Slack",
                        value: "9 d",
                        edge: "warn",
                        delta: { value: "-14 d", direction: "down", good: "up" },
                    },
                    { label: "Over capacity", value: "4 cells", tone: "warn" },
                ]}
            />

            <Section title="Roadmap" note="dashed outline: baseline position">
                <div className="mb-3 flex flex-wrap items-center gap-3">
                    <SegmentedControl
                        label="View"
                        value={view}
                        onChange={(v) => setView(v === "baseline" || v === "current" ? v : "compare")}
                        options={[
                            { value: "baseline", label: "Baseline" },
                            { value: "current", label: "Current" },
                            { value: "compare", label: "Compare" },
                        ]}
                    />
                    <FilterChips
                        label="Lanes"
                        items={PLAN.lanes.map((l, i) => ({ id: l.id, label: l.label, color: SERIES_COLOR[i] }))}
                        value={shown}
                        onChange={setShown}
                        bulk
                    />
                </div>
                <Gantt
                    axis={PLAN.axis}
                    lanes={PLAN.lanes}
                    bars={bars}
                    milestones={PLAN.milestones}
                    today={PLAN.today}
                    view={view}
                    hiddenLanes={PLAN.lanes.filter((l) => !shown.includes(l.id)).map((l) => l.id)}
                    labelTitle="Lane / item"
                    editable
                    onBarChange={(id, next, phase) => {
                        if (phase === "commit") {
                            setBars((all) => all.map((b) => (b.id === id ? { ...b, ...next } : b)));
                        }
                    }}
                />
                <Collapse summary="The plan as a table">
                    <GanttTable lanes={PLAN.lanes} bars={bars} milestones={PLAN.milestones} view={view} />
                </Collapse>
            </Section>

            <Section title="Capacity" note="hours per sprint">
                <CapacityGrid unit="h" totals cols={PLAN.sprints} rows={PLAN.capacity} />
            </Section>

            <Section title="Sync log">
                <ChangeLedger entries={LEDGER} />
            </Section>
        </Page>
    );
}
