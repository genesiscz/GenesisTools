import {
    Collapse,
    FilterChips,
    Gantt,
    type GanttBar,
    type GanttLane,
    type GanttMilestone,
    GanttTable,
    type GanttView,
    SegmentedControl,
} from "@artifact/kit";
import { useState } from "react";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";

export const meta: GalleryMeta = {
    family: "Planning",
    title: "Gantt",
    summary: "Sprint axis, tinted lanes, baseline ghosts with a shift label, milestones, a today line, drag editing.",
    components: ["Gantt", "GanttTable"],
};

const AXIS = { start: "2026-09-14", end: "2027-03-28" };
const LANES: GanttLane[] = [
    { id: "discovery", label: "Discovery", meta: "3 items" },
    { id: "platform", label: "Platform", meta: "4 items" },
    { id: "client", label: "Client apps", meta: "3 items" },
];
const START_BARS: GanttBar[] = [
    {
        id: "d1",
        lane: "discovery",
        label: "Interview ten customers",
        start: "2026-09-14",
        end: "2026-09-25",
        barLabel: "6.0 d",
        progress: 1,
    },
    {
        id: "d2",
        lane: "discovery",
        label: "Write the problem brief",
        start: "2026-09-28",
        end: "2026-10-09",
        barLabel: "4.5 d",
        progress: 0.6,
    },
    {
        id: "d3",
        lane: "discovery",
        label: "Prototype review",
        start: "2026-10-12",
        end: "2026-10-15",
        barLabel: "2.0 d",
    },
    {
        id: "p1",
        lane: "platform",
        label: "Data model and migrations",
        start: "2026-10-12",
        end: "2026-11-06",
        barLabel: "12.0 d",
        ghost: { start: "2026-09-28", end: "2026-10-23" },
    },
    {
        id: "p2",
        lane: "platform",
        label: "Public API, read endpoints",
        start: "2026-11-09",
        end: "2026-12-04",
        barLabel: "10.0 d",
    },
    {
        id: "p3",
        lane: "platform",
        label: "Public API, write endpoints",
        start: "2026-12-07",
        end: "2027-01-15",
        barLabel: "14.0 d",
        ghost: { start: "2026-11-23", end: "2026-12-18" },
    },
    {
        id: "p4",
        lane: "platform",
        label: "Load test and tuning",
        start: "2027-01-18",
        end: "2027-01-29",
        barLabel: "4.0 d",
    },
    {
        id: "c1",
        lane: "client",
        label: "Web client shell",
        start: "2026-11-02",
        end: "2026-11-27",
        barLabel: "9.0 d",
        ghost: { start: "2026-11-09", end: "2026-12-04" },
    },
    {
        id: "c2",
        lane: "client",
        label: "Mobile client screens",
        start: "2026-12-07",
        end: "2027-02-12",
        barLabel: "20.0 d",
    },
    {
        id: "c3",
        lane: "client",
        label: "Accessibility pass",
        start: "2027-02-15",
        end: "2027-02-26",
        barLabel: "3.0 d",
    },
];
const MILESTONES: GanttMilestone[] = [
    { id: "m1", label: "Beta opens", date: "2026-12-11", ghost: "2026-11-27" },
    { id: "m2", label: "Design review", date: "2026-10-23" },
];

export default function GanttPage() {
    const [bars, setBars] = useState(START_BARS);
    const [view, setView] = useState<GanttView>("compare");
    const [shown, setShown] = useState(LANES.map((l) => l.id));
    const [last, setLast] = useState("Drag a bar, an edge, or use the keyboard.");

    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="Tab reaches the chart once. Up and Down move between bars, Home and End jump. Left and Right move a bar a day, Shift with Left or Right moves its end, Shift with Alt moves its start. Escape cancels a drag. Every change is announced."
        >
            <Demo title="Editable plan with a baseline" note={last}>
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
                        items={LANES.map((l, i) => ({ id: l.id, label: l.label, color: `var(--series-${i + 1})` }))}
                        value={shown}
                        onChange={setShown}
                    />
                </div>
                <Gantt
                    axis={AXIS}
                    lanes={LANES}
                    bars={bars}
                    milestones={MILESTONES}
                    markers={[{ date: "2027-03-01", label: "Code freeze", tone: "warn" }]}
                    today="2026-10-14"
                    view={view}
                    hiddenLanes={LANES.filter((l) => !shown.includes(l.id)).map((l) => l.id)}
                    labelTitle="Lane / item"
                    editable
                    locale="en-GB"
                    maxHeight={520}
                    onBarChange={(id, next, phase) => {
                        if (phase === "commit") {
                            setBars((all) => all.map((b) => (b.id === id ? { ...b, ...next } : b)));
                            setLast(`${id} moved to ${next.start} to ${next.end}`);
                        }
                    }}
                />
                <Collapse summary="The same plan as a table">
                    <GanttTable lanes={LANES} bars={bars} milestones={MILESTONES} view={view} locale="en-GB" />
                </Collapse>
            </Demo>
            <Demo
                title="Edge case: narrow bars and an empty lane"
                note="Bars under the label threshold drop their text"
            >
                <Gantt
                    axis={{ start: "2026-10-01", end: "2026-11-30", cellDays: 7, cellLabel: (n) => `Week ${n}` }}
                    lanes={[
                        { id: "a", label: "Short tasks" },
                        { id: "b", label: "Nothing planned yet" },
                    ]}
                    bars={[
                        {
                            id: "s1",
                            lane: "a",
                            label: "One day",
                            start: "2026-10-05",
                            end: "2026-10-05",
                            barLabel: "1 d",
                        },
                        {
                            id: "s2",
                            lane: "a",
                            label: "Four days",
                            start: "2026-10-07",
                            end: "2026-10-10",
                            barLabel: "8.0 h",
                        },
                        {
                            id: "s3",
                            lane: "a",
                            label: "Eight days",
                            start: "2026-10-13",
                            end: "2026-10-20",
                            barLabel: "8.0 h",
                        },
                    ]}
                    labelWidth={220}
                />
            </Demo>
        </GalleryPage>
    );
}
