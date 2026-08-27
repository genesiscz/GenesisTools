// Served via `tools artifact serve <this-file>` — opens the clean URL, HMR on edit.
// React, Tailwind and the kit come from GenesisTools; nothing to install here.
// Full kit API: `tools artifact kit`
import { Callout, DataTable, Hero, Page, Section, StatGrid } from "@artifact/kit";

const STATS = [
    { label: "sample stat", value: "42", tone: "ok" as const },
    { label: "another", value: "7/9", tone: "warn" as const },
    { label: "third", value: "1.21s" },
];

const ROWS = [
    { item: "sample row", status: "ok", value: "1.21" },
    { item: "second row", status: "warn", value: "0.34" },
];

export default function Dashboard() {
    return (
        <Page>
            <Hero title="{{TITLE}}" subtitle="Replace this with one or two sentences on what this dashboard shows." />
            <StatGrid stats={STATS} />

            <Section title="Details">
                <DataTable
                    columns={[
                        { key: "item", label: "Item" },
                        { key: "status", label: "Status" },
                        { key: "value", label: "Value", mono: true },
                    ]}
                    rows={ROWS}
                />
            </Section>

            <Callout tone="info" title="Next steps">
                Put data in a sibling `data.json` and `fetch("./data.json")` it, or import it statically. Build a
                shareable single file with `tools artifact build`.
            </Callout>
        </Page>
    );
}
