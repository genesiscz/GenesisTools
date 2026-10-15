import { Compare, Figure, JsonView, Steps, TreeView, treeFromPaths } from "@artifact/kit";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";

export const meta: GalleryMeta = {
    family: "Structure",
    title: "Trees, steps and comparisons",
    summary:
        "Collapsible trees (also from file paths), a pipeline stepper, side-by-side options, a JSON explorer and an image figure.",
    components: ["TreeView", "treeFromPaths", "Steps", "Compare", "JsonView", "Figure"],
};

const FILES = treeFromPaths([
    { path: "src/api/orders.ts", meta: "212 lines" },
    { path: "src/api/refunds.ts", meta: "98 lines", badge: "new", tone: "ok" },
    { path: "src/queue/worker.ts", meta: "340 lines", tone: "err", note: "holds the **retry** bug" },
    "src/queue/retry.ts",
    "docs/runbook.md",
    "README.md",
]);

const PAYLOAD = {
    id: "ord_1042",
    status: "paid",
    total: { amount: 38.2, currency: "EUR" },
    items: [
        { sku: "MUG-01", qty: 2 },
        { sku: "TEE-07", qty: 1 },
    ],
    notes: null,
    gift: false,
    description:
        "A long description that runs past the cut-off so the explorer shortens it and keeps the full text in the title attribute for hover. ".repeat(
            2
        ),
};

const PICTURE = `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240" viewBox="0 0 640 240"><rect width="640" height="240" fill="#2b6cb0"/><rect x="40" y="140" width="80" height="70" fill="#90cdf4"/><rect x="160" y="100" width="80" height="110" fill="#90cdf4"/><rect x="280" y="60" width="80" height="150" fill="#90cdf4"/><rect x="400" y="120" width="80" height="90" fill="#90cdf4"/><rect x="520" y="30" width="80" height="180" fill="#f6e05e"/></svg>'
)}`;

export default function StructurePage() {
    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="TreeView and JsonView rows with children are buttons: Tab moves between them, Enter or Space opens and closes one. Figure's image is a button when zoom is on: Enter opens the full-size dialog and Escape closes it."
        >
            <Demo title="TreeView from file paths" note="treeFromPaths, folders first, top level open">
                <TreeView nodes={FILES} />
            </Demo>
            <Demo title="TreeView from nodes" note="an org chart, two levels open">
                <TreeView
                    open={2}
                    nodes={[
                        {
                            label: "Platform",
                            badge: "12",
                            children: [
                                { label: "API team", meta: "5 people", children: [{ label: "On-call rotation" }] },
                                { label: "Data team", meta: "4 people" },
                            ],
                        },
                        { label: "Client apps", badge: "8", children: [{ label: "Web" }, { label: "Mobile" }] },
                    ]}
                />
            </Demo>
            <Demo title="Steps" note="every status, row direction">
                <Steps
                    steps={[
                        { label: "Build", status: "done", meta: "1m 12s" },
                        { label: "Unit tests", status: "done", meta: "3m 40s" },
                        { label: "Deploy to staging", status: "active", body: "Rolling out to 3 of 6 nodes." },
                        { label: "Smoke tests", status: "failed", meta: "2 of 40 failed" },
                        { label: "Docs", status: "skipped" },
                        { label: "Deploy to production", status: "pending" },
                    ]}
                />
            </Demo>
            <Demo title="Compare" note="three options with badges">
                <Compare
                    items={[
                        {
                            title: "Raise the timeout",
                            tone: "err",
                            badge: "rejected",
                            body: "Hides the bug; jobs still pile up.",
                        },
                        {
                            title: "Cap the delay",
                            tone: "ok",
                            badge: "chosen",
                            body: "One line, bounded wait, **no** new state.",
                        },
                        {
                            title: "Move to a scheduler",
                            tone: "warn",
                            badge: "later",
                            body: "Better long term; two weeks of work.",
                        },
                    ]}
                />
            </Demo>
            <Demo title="JsonView" note="two levels open, long strings cut at 160 characters">
                <JsonView value={PAYLOAD} name="order" />
            </Demo>
            <Demo title="Figure" note="click to open at full size">
                <Figure
                    src={PICTURE}
                    alt="Bar chart of five invented weekly totals"
                    caption="Weekly totals, **week 5** highlighted."
                    width={420}
                />
            </Demo>
            <Demo title="Edge case: empty inputs" note="an empty tree, an empty object, steps with one item">
                <TreeView nodes={[]} />
                <JsonView value={{}} name="empty" />
                <Steps steps={[{ label: "Only step", status: "active" }]} direction="column" />
            </Demo>
        </GalleryPage>
    );
}
