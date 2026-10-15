import { Bullets, DataTable, KeyValue, QA, SeriesTable, StatGrid, Timeline } from "@artifact/kit";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";

export const meta: GalleryMeta = {
    family: "Data",
    title: "Tables, lists and timelines",
    summary:
        "Stat tiles, a filterable table, a series table, a timeline, bullets, questions and answers, key and value rows.",
    components: ["StatGrid", "DataTable", "SeriesTable", "Timeline", "Bullets", "QA", "KeyValue"],
};

const REGIONS = ["North", "South", "East", "West", "Central"];

export default function DataPage() {
    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="DataTable's filter box is a plain text input: Tab reaches it, typing filters the rows. Each QA question is a details row: Tab reaches it, Enter or Space opens it. Everything else is static."
        >
            <Demo title="StatGrid" note="default columns">
                <StatGrid
                    stats={[
                        { label: "Orders", value: "12,480", tone: "ok", hint: "since **Monday**" },
                        { label: "Refunds", value: "312", tone: "warn" },
                        { label: "Failed payments", value: "41", tone: "err" },
                        { label: "Median basket", value: "38.20 EUR" },
                    ]}
                />
            </Demo>
            <Demo title="DataTable" note="filter, row tones, markdown cells">
                <DataTable
                    filter
                    markdown
                    caption="Open incidents by region"
                    columns={[
                        { key: "region", label: "Region" },
                        { key: "status", label: "Status" },
                        { key: "count", label: "Incidents", mono: true },
                        { key: "note", label: "Note" },
                    ]}
                    rows={REGIONS.map((region, i) => ({
                        region,
                        status: { text: i === 2 ? "degraded" : "ok", tone: i === 2 ? "err" : "ok" },
                        count: i * 3 + 1,
                        note: i === 2 ? "**Disk full** on two nodes" : "`nominal`",
                    }))}
                    rowTone={(_, index) => (index === 2 ? "err" : undefined)}
                />
            </Demo>
            <Demo title="SeriesTable" note="a chart fallback with a marker column">
                <SeriesTable
                    caption="Requests per day (thousands)"
                    labels={["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]}
                    series={[
                        { label: "Web", data: [42, 45, 44, 51, 48, 30, 28], tone: "info" },
                        { label: "Mobile", data: [18, 19, 22, 25, 24, 31, 33], tone: "ok" },
                    ]}
                    marker={{ at: 3, label: "release" }}
                />
            </Demo>
            <Demo title="Timeline">
                <Timeline
                    entries={[
                        {
                            time: "09:12",
                            title: "Alert fired",
                            body: "Error rate above 2% for five minutes.",
                            tone: "err",
                        },
                        { time: "09:20", title: "Rollback started", tone: "warn" },
                        { time: "09:31", title: "Recovered", body: "Error rate back to **0.3%**.", tone: "ok" },
                        { time: "10:05", body: "Body-only entry: a note added after the fact." },
                    ]}
                />
            </Demo>
            <Demo title="Bullets" note="tone, confidence badge and a sub-line">
                <Bullets
                    items={[
                        "A plain item",
                        { text: "The cache miss rate doubled after the deploy", tone: "warn", confidence: 80 },
                        {
                            text: "The root cause is the new key format",
                            confidence: 60,
                            sub: "Two keys differ only in case.",
                        },
                    ]}
                />
                <Bullets ordered items={["Drain the node", "Replace the disk", "Rejoin the cluster"]} />
            </Demo>
            <Demo title="QA" note="verdicts, a featured question, meta chips">
                <QA
                    items={[
                        {
                            q: "Did the retry fix reduce errors?",
                            a: "Yes. Errors fell from 1.8% to 0.4% within an hour of the deploy.",
                            verdict: "confirmed",
                            tone: "ok",
                            featured: true,
                            meta: [{ k: "topic", v: "reliability" }],
                        },
                        { q: "Is the queue sized correctly?", a: "Not yet measured.", verdict: "open", tone: "warn" },
                    ]}
                />
            </Demo>
            <Demo title="KeyValue" note="two columns, mono values">
                <KeyValue
                    title="Service config"
                    columns={2}
                    items={[
                        { key: "Region", value: "north-1" },
                        { key: "Replicas", value: "6", mono: true },
                        { key: "Timeout", value: "`30 s`" },
                        { key: "Status", value: "healthy", tone: "ok" },
                    ]}
                />
            </Demo>
            <Demo title="Edge case: empty and very long values" note="no rows, one 200-character value">
                <DataTable caption="Nothing matched" columns={[{ key: "name", label: "Name" }]} rows={[]} />
                <KeyValue
                    items={[
                        { key: "Token scope", value: "read write admin ".repeat(12).trim(), mono: true },
                        { key: "Empty", value: "" },
                    ]}
                />
            </Demo>
        </GalleryPage>
    );
}
