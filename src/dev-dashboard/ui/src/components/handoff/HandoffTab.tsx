import type { HandoffListRow, HandoffPostResponse } from "@app/dev-dashboard/lib/handoff-types";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { useMemo, useState } from "react";
import { useActivityPanel } from "@/hooks/useActivityPanel";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useQaStream } from "@/hooks/useQaStream";
import { ActivityPanel } from "./ActivityPanel";
import { HandoffDetail } from "./HandoffDetail";
import { HandoffCreateDialog } from "./HandoffDialogs";
import { useHandoffList } from "./useHandoffApi";

const STATUS_GROUPS: { key: string; label: string }[] = [
    { key: "open", label: "Open" },
    { key: "claimed", label: "Claimed" },
    { key: "done", label: "Done" },
    { key: "cancelled", label: "Cancelled" },
];

function statusDot(status: string): string {
    if (status === "open") {
        return "#a3e635";
    }

    if (status === "claimed") {
        return "#c792ea";
    }

    if (status === "done") {
        return "var(--dd-text-muted)";
    }

    return "var(--dd-danger)";
}

function HandoffRow({
    row,
    ordinal,
    selected,
    onSelect,
}: {
    row: HandoffListRow;
    ordinal: number;
    selected: boolean;
    onSelect: (id: string) => void;
}) {
    return (
        <button
            type="button"
            className={`flex w-full cursor-pointer flex-col gap-1 rounded border px-3 py-2 text-left transition-all duration-200 hover:-translate-y-px hover:border-primary/50 ${
                selected ? "border-primary/60 bg-primary/10" : "border-[var(--dd-border)]/60 bg-black/10"
            }`}
            onClick={() => onSelect(row.id)}
        >
            <div className="flex items-center gap-2">
                <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: statusDot(row.status) }}
                />
                <span className="font-mono text-[10px] text-[var(--dd-text-muted)]">#{ordinal}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--dd-text-primary)]">{row.title}</span>
                <span className="font-mono text-[10px] text-[var(--dd-text-secondary)]">
                    {row.progress ?? row.tasks}
                </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] text-[var(--dd-text-muted)]">
                {row.project !== null ? <span>{row.project}</span> : null}
                {row.postedBy.sessionName !== null ? <span>by {row.postedBy.sessionName}</span> : null}
                {row.claimedBy !== undefined && row.claimedBy.length > 0 ? (
                    <span className="text-[#c792ea]">
                        → {row.claimedBy.map((c) => c.sessionName ?? c.sessionId ?? "unnamed").join(", ")}
                    </span>
                ) : null}
                {row.target !== undefined ? (
                    <span className="rounded border border-[var(--dd-border)] px-1 py-px">
                        @{row.target.sessionName ?? row.target.sessionId}
                    </span>
                ) : null}
                <span>{row.ageHours < 24 ? `${row.ageHours}h` : `${Math.round(row.ageHours / 24)}d`}</span>
            </div>
        </button>
    );
}

export function HandoffTab() {
    const list = useHandoffList();
    const queryClient = useQueryClient();
    const activityPanel = useActivityPanel();
    const isDesktop = useMediaQuery("(min-width: 1024px)");
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [openOnly, setOpenOnly] = useState(false);
    const [project, setProject] = useState<string>("");
    const [createOpen, setCreateOpen] = useState(false);
    const [editIdToast, setEditIdToast] = useState<HandoffPostResponse | null>(null);
    const rows = useMemo(() => list.data?.handoffs ?? [], [list.data]);

    // Unified /api/qa/stream — handoff frames invalidate list + detail (+ events when selected).
    useQaStream((frame) => {
        if (frame.type !== "handoff") {
            return;
        }

        void queryClient.invalidateQueries({ queryKey: ["handoff-log"] });
        void queryClient.invalidateQueries({ queryKey: ["handoff", frame.id] });
        void queryClient.invalidateQueries({ queryKey: ["handoff-events", frame.id] });
    });

    const projects = useMemo(
        () => [...new Set(rows.map((r) => r.project).filter((p): p is string => p !== null))].sort(),
        [rows]
    );
    const filtered = rows.filter(
        (r) => (!openOnly || r.status === "open" || r.status === "claimed") && (project === "" || r.project === project)
    );
    const ordinalById = new Map(filtered.map((row, index) => [row.id, index + 1]));
    const activityColumn = activityPanel.state === "collapsed" ? "44px" : "340px";

    return (
        <div
            className="grid grid-cols-1 gap-4 transition-[grid-template-columns] duration-200 ease-out"
            style={isDesktop ? { gridTemplateColumns: `minmax(0,0.7fr) minmax(0,1.6fr) ${activityColumn}` } : undefined}
        >
            <div className="dd-panel flex flex-col gap-3 self-start p-3">
                <div className="flex items-center gap-2">
                    <Button
                        size="sm"
                        className="transition-[filter] hover:brightness-110"
                        onClick={() => setCreateOpen(true)}
                    >
                        + New handoff
                    </Button>
                    <label className="flex cursor-pointer items-center gap-1.5 font-mono text-[10px] text-[var(--dd-text-muted)]">
                        <input
                            type="checkbox"
                            checked={openOnly}
                            onChange={(e) => setOpenOnly(e.target.checked)}
                            className="accent-[var(--color-primary)]"
                        />
                        open only
                    </label>
                    <select
                        value={project}
                        onChange={(e) => setProject(e.target.value)}
                        className="ml-auto rounded border border-[var(--dd-border)] bg-black/25 px-1.5 py-0.5 font-mono text-[10px] text-[var(--dd-text-secondary)]"
                    >
                        <option value="">all projects</option>
                        {projects.map((p) => (
                            <option key={p} value={p}>
                                {p}
                            </option>
                        ))}
                    </select>
                </div>

                {list.isLoading ? (
                    <p className="py-6 text-center text-xs text-[var(--dd-text-muted)]">Loading handoffs…</p>
                ) : list.isError ? (
                    <p className="py-6 text-center text-xs text-[var(--dd-danger)]">{String(list.error)}</p>
                ) : filtered.length === 0 ? (
                    <p className="py-6 text-center text-xs text-[var(--dd-text-muted)]">
                        No handoffs yet — post one from an agent (handoff_post) or the button above.
                    </p>
                ) : (
                    STATUS_GROUPS.map((group) => {
                        const groupRows = filtered.filter((r) => r.status === group.key);

                        if (groupRows.length === 0) {
                            return null;
                        }

                        return (
                            <div key={group.key} className="flex flex-col gap-1.5">
                                <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--dd-text-muted)]">
                                    {group.label} · {groupRows.length}
                                </span>
                                {groupRows.map((row) => (
                                    <HandoffRow
                                        key={row.id}
                                        row={row}
                                        ordinal={ordinalById.get(row.id) ?? 0}
                                        selected={row.id === selectedId}
                                        onSelect={setSelectedId}
                                    />
                                ))}
                            </div>
                        );
                    })
                )}
            </div>

            <div className="min-w-0">
                {selectedId !== null ? (
                    <HandoffDetail key={selectedId} id={selectedId} />
                ) : (
                    <div className="dd-panel flex h-40 items-center justify-center text-sm text-[var(--dd-text-muted)]">
                        Select a handoff to inspect and edit it.
                    </div>
                )}
            </div>

            <ActivityPanel id={selectedId} />

            <HandoffCreateDialog
                open={createOpen}
                onOpenChange={setCreateOpen}
                onCreated={(res) => {
                    setEditIdToast(res);
                    setSelectedId(res.handoff.id);
                }}
            />

            {editIdToast !== null ? (
                <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-1.5 rounded border border-primary/50 bg-[var(--dd-bg-panel)] px-4 py-3 shadow-[0_0_40px_rgba(0,0,0,0.6)]">
                    <p className="text-sm text-[var(--dd-text-primary)]">Posted {editIdToast.handoff.id}</p>
                    <p className="font-mono text-[10px] text-[var(--dd-text-muted)]">
                        editId (the dashboard can always re-reveal it):
                    </p>
                    <div className="flex items-center gap-2">
                        <code className="dd-accent-text font-mono text-xs">{editIdToast.editId}</code>
                        <button
                            type="button"
                            className="cursor-pointer font-mono text-[10px] text-[var(--dd-text-secondary)] hover:text-[var(--dd-text-primary)]"
                            onClick={() => {
                                navigator.clipboard
                                    .writeText(editIdToast.editId)
                                    .catch((err) => console.error("copy editId failed", err));
                            }}
                        >
                            copy
                        </button>
                        <button
                            type="button"
                            className="cursor-pointer font-mono text-[10px] text-[var(--dd-text-muted)] hover:text-[var(--dd-text-primary)]"
                            onClick={() => setEditIdToast(null)}
                        >
                            dismiss
                        </button>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
