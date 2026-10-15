import { type EditableColumn, type EditableRow, EditableTable } from "@artifact/kit";
import { useState } from "react";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";

export const meta: GalleryMeta = {
    family: "Data",
    title: "Editable table",
    summary: "Input cells with drafts, add and remove, validation, totals and row moves.",
    components: ["EditableTable"],
};

const DAY = 86_400_000;

function days(row: EditableRow): string {
    const from = typeof row.start === "string" ? Date.parse(row.start) : Number.NaN;
    const to = typeof row.end === "string" ? Date.parse(row.end) : Number.NaN;

    return Number.isNaN(from) || Number.isNaN(to) ? "" : `${Math.round((to - from) / DAY) + 1} d`;
}

const COLUMNS: EditableColumn[] = [
    { key: "task", label: "Task", required: true },
    {
        key: "lane",
        label: "Lane",
        type: "select",
        options: [
            { value: "platform", label: "Platform" },
            { value: "client", label: "Client apps" },
        ],
    },
    { key: "start", label: "Start", type: "date", min: "2026-09-01" },
    {
        key: "end",
        label: "End",
        type: "date",
        validate: (value, row) =>
            typeof value === "string" && typeof row.start === "string" && value < row.start
                ? "Ends before it starts"
                : undefined,
    },
    { key: "length", label: "Length", type: "number", render: (row) => days(row) },
    {
        key: "hours",
        label: "Hours",
        type: "number",
        total: "sum",
        validate: (value) => (typeof value === "number" && value > 80 ? "More than two weeks of work" : undefined),
    },
];

export default function EditableTablePage() {
    const [rows, setRows] = useState<EditableRow[]>([
        { task: "Data model", lane: "platform", start: "2026-10-12", end: "2026-11-06", hours: 64 },
        { task: "Read endpoints", lane: "platform", start: "2026-11-09", end: "2026-12-04", hours: 48 },
        { task: "Web shell", lane: "client", start: "2026-11-02", end: "2026-10-27", hours: 96 },
        { task: "", lane: "client", start: "2026-12-07", end: "2027-01-15", hours: null },
    ]);
    const [last, setLast] = useState("no change yet");

    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="Tab walks the cells. Enter commits and moves down the column, Escape puts the cell back. Numbers commit on blur or Enter. Add row focuses the new row."
        >
            <Demo title="A plan with problems to fix" note={last}>
                <EditableTable
                    caption="Work items"
                    columns={COLUMNS}
                    rows={rows}
                    reorder
                    newRow={() => ({ task: "", lane: "platform", start: "", end: "", hours: null })}
                    onChange={(next, change) => {
                        setRows(next);
                        setLast(`${change.type} at row ${change.index + 1}${change.key ? `, ${change.key}` : ""}`);
                    }}
                />
            </Demo>
            <Demo title="Edge case: empty">
                <EditableTable
                    columns={COLUMNS.slice(0, 2)}
                    rows={[]}
                    onChange={() => {}}
                    emptyText="No work items yet."
                />
            </Demo>
        </GalleryPage>
    );
}
