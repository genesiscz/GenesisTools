import { ChangeLedger, diffFields, type FieldChange, type LedgerEntry } from "@artifact/kit";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";

export const meta: GalleryMeta = {
    family: "Data",
    title: "Change ledger",
    summary: "A history of sync runs, each opening to its added, removed and changed fields.",
    components: ["ChangeLedger"],
};

const BULK: FieldChange[] = Array.from({ length: 34 }, (_, i) => ({
    field: "remaining",
    kind: "changed" as const,
    from: 40 - i,
    to: 38 - i,
}));

const ENTRIES: LedgerEntry[] = [
    {
        id: "sync-3",
        time: "2026-10-14T16:20:00Z",
        title: "Sync from the issue tracker",
        tone: "warn",
        meta: [
            { k: "items", v: "96" },
            { k: "forecast", v: "+8 d", tone: "err" },
        ],
        open: true,
        items: [
            {
                id: "w-102",
                label: "Public API, write endpoints",
                href: "#change-ledger",
                changes: diffFields(
                    { state: "New", estimate: 10, owner: "Ada", iteration: "Sprint 3" },
                    { state: "Active", estimate: 14, iteration: "Sprint 4", blocked: true }
                ),
            },
            {
                id: "w-117",
                label: "Web client shell",
                changes: [{ field: "title", kind: "changed", from: "Client shell", to: "Web client shell" }],
            },
        ],
    },
    {
        id: "sync-2",
        time: "2026-10-12T09:05:00Z",
        title: "Nightly sync",
        tone: "ok",
        changes: BULK,
    },
    {
        id: "sync-1",
        time: "2026-10-10T09:00:00Z",
        title: "First import",
        tone: "info",
        changes: [],
    },
];

export default function ChangeLedgerPage() {
    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="Each entry is a native details element: Tab reaches its summary, Space or Enter opens it. Expand all and Collapse all are buttons. Every change row has a hidden sentence."
        >
            <Demo title="Three runs">
                <ChangeLedger
                    entries={ENTRIES}
                    formatValue={(field, value) =>
                        field === "estimate" && typeof value === "number" ? `${value} d` : String(value ?? "empty")
                    }
                />
            </Demo>
            <Demo title="Edge case: a run with 34 changes" note="maxChanges 10 shows a Show all button">
                <ChangeLedger entries={[{ ...ENTRIES[1], id: "bulk", open: true }]} maxChanges={10} />
            </Demo>
        </GalleryPage>
    );
}
