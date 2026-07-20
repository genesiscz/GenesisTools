import type { HandoffActionInput, HandoffTask, PublicHandoff } from "@app/dev-dashboard/lib/handoff-types";
import { Checkbox } from "@ui/components/checkbox";
import { Input } from "@ui/components/input";
import { useState } from "react";
import { AttachmentStrip } from "./HandoffAttachments";
import { HandoffProofDialog } from "./HandoffDialogs";

function CommitChip({ sha }: { sha: string }) {
    return (
        <button
            type="button"
            className="cursor-pointer rounded border border-[var(--dd-border)] bg-black/25 px-1.5 py-px font-mono text-[10px] text-[var(--dd-text-secondary)] hover:border-primary/60"
            onClick={() => {
                navigator.clipboard.writeText(sha).catch((err) => console.error("copy SHA failed", err));
            }}
            title="copy SHA"
        >
            {sha}
        </button>
    );
}

export function HandoffTaskRow({
    task,
    attachments,
    disabled,
    onActions,
}: {
    task: HandoffTask;
    attachments: PublicHandoff["attachments"];
    disabled: boolean;
    onActions: (actions: HandoffActionInput[]) => void;
}) {
    const [proofOpen, setProofOpen] = useState(false);
    const [denyOpen, setDenyOpen] = useState(false);
    const [denyReason, setDenyReason] = useState("");
    const [editing, setEditing] = useState(false);
    const [editText, setEditText] = useState(task.text);
    const [editCriteria, setEditCriteria] = useState(task.acceptanceCriteria ?? "");
    const [proofExpanded, setProofExpanded] = useState(false);
    const taskAttachments = attachments.filter((a) => a.taskId === task.id);
    const proofIds = task.proof?.attachmentIds ?? [];

    const onToggle = (): void => {
        if (task.checked) {
            if (window.confirm("Uncheck this task? The current proof is cleared (history stays in the event log).")) {
                onActions([{ action: "uncheck_task", taskId: task.id }]);
            }

            return;
        }

        if (task.denied) {
            if (
                window.confirm(
                    `Task is denied ("${task.deniedReason ?? ""}") — force-check anyway (clears the denial)?`
                )
            ) {
                setProofOpen(true);
            }

            return;
        }

        setProofOpen(true);
    };

    const submitDeny = (): void => {
        const reason = denyReason.trim();

        if (reason.length === 0) {
            return;
        }

        if (task.checked && !window.confirm("Task is checked — force-deny anyway (proof stays visible)?")) {
            return;
        }

        onActions([{ action: "deny_task", taskId: task.id, reason, ...(task.checked ? { force: true } : {}) }]);
        setDenyOpen(false);
        setDenyReason("");
    };

    const saveEdit = (): void => {
        const patch: { action: string; taskId: string; text?: string; acceptanceCriteria?: string } = {
            action: "modify_task",
            taskId: task.id,
        };

        if (editText.trim().length > 0 && editText !== task.text) {
            patch.text = editText;
        }

        if (editCriteria !== (task.acceptanceCriteria ?? "")) {
            patch.acceptanceCriteria = editCriteria;
        }

        if (patch.text !== undefined || patch.acceptanceCriteria !== undefined) {
            onActions([patch as HandoffActionInput]);
        }

        setEditing(false);
    };

    return (
        <div
            data-task-id={task.id}
            tabIndex={0}
            className="flex flex-col gap-1.5 rounded border border-[var(--dd-border)]/60 bg-black/10 px-3 py-2 focus-within:border-primary/40"
        >
            <div className="flex items-start gap-2.5">
                <Checkbox
                    checked={task.checked}
                    disabled={disabled}
                    onCheckedChange={onToggle}
                    className="mt-0.5"
                    aria-label={`check ${task.id}`}
                />
                <div className="min-w-0 flex-1">
                    {editing ? (
                        <div className="flex flex-col gap-1.5">
                            <Input
                                value={editText}
                                onChange={(e) => setEditText(e.target.value)}
                                className="border-[var(--dd-border)] bg-black/25 text-sm"
                            />
                            <Input
                                value={editCriteria}
                                onChange={(e) => setEditCriteria(e.target.value)}
                                className="border-[var(--dd-border)] bg-black/15 text-xs"
                                placeholder="acceptance criteria"
                            />
                            <div className="flex gap-2 text-xs">
                                <button type="button" className="dd-accent-text cursor-pointer" onClick={saveEdit}>
                                    save
                                </button>
                                <button
                                    type="button"
                                    className="cursor-pointer text-[var(--dd-text-muted)]"
                                    onClick={() => setEditing(false)}
                                >
                                    cancel
                                </button>
                            </div>
                        </div>
                    ) : (
                        <>
                            <p
                                className={`text-sm text-[var(--dd-text-primary)]${task.denied ? " line-through opacity-60" : ""}`}
                            >
                                <span className="mr-1.5 font-mono text-[10px] text-[var(--dd-text-muted)]">
                                    {task.id}
                                </span>
                                {task.text}
                            </p>
                            {task.acceptanceCriteria ? (
                                <p className="mt-0.5 text-xs text-[var(--dd-text-muted)]">
                                    ✓? {task.acceptanceCriteria}
                                </p>
                            ) : null}
                        </>
                    )}

                    {task.denied ? (
                        <p className="mt-1 inline-flex items-center gap-1.5 rounded border border-[var(--dd-danger)]/40 bg-[var(--dd-danger)]/10 px-2 py-0.5 text-[11px] text-[var(--dd-danger)]">
                            denied: {task.deniedReason}
                            <span className="text-[var(--dd-text-muted)]">
                                — {task.deniedBy?.sessionName ?? task.deniedBy?.agent}
                            </span>
                        </p>
                    ) : null}

                    {task.checked && task.proof ? (
                        <div className="mt-1">
                            <button
                                type="button"
                                className="dd-accent-text cursor-pointer text-[11px] hover:opacity-80"
                                onClick={() => setProofExpanded((v) => !v)}
                            >
                                {proofExpanded ? "▴ proof" : "▾ proof"}
                                <span className="ml-1 text-[var(--dd-text-muted)]">
                                    by {task.checkedBy?.sessionName ?? task.checkedBy?.agent}
                                    {task.checkedBy?.via === "dashboard" ? " via dashboard" : ""}
                                </span>
                            </button>
                            {proofExpanded ? (
                                <div className="mt-1 flex flex-col gap-1.5 rounded border border-[var(--dd-border)]/50 bg-black/20 p-2 text-xs text-[var(--dd-text-secondary)]">
                                    <p className="whitespace-pre-wrap">{task.proof.answer}</p>
                                    {task.proof.commitIds !== undefined && task.proof.commitIds.length > 0 ? (
                                        <div className="flex flex-wrap gap-1.5">
                                            {task.proof.commitIds.map((sha) => (
                                                <CommitChip key={sha} sha={sha} />
                                            ))}
                                        </div>
                                    ) : null}
                                    {task.proof.context ? (
                                        <p className="text-[var(--dd-text-muted)]">{task.proof.context}</p>
                                    ) : null}
                                    <AttachmentStrip attachments={attachments} ids={proofIds} />
                                </div>
                            ) : null}
                        </div>
                    ) : null}

                    <div className="mt-1">
                        <AttachmentStrip
                            attachments={taskAttachments.filter((a) => !proofIds.includes(a.attachmentId))}
                        />
                    </div>

                    {denyOpen ? (
                        <div className="mt-1.5 flex items-center gap-2">
                            <Input
                                value={denyReason}
                                onChange={(e) => setDenyReason(e.target.value)}
                                className="h-7 border-[var(--dd-border)] bg-black/25 text-xs"
                                placeholder="reason (required)"
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                        submitDeny();
                                    }
                                }}
                            />
                            <button
                                type="button"
                                className={`cursor-pointer text-xs ${denyReason.trim().length === 0 ? "cursor-not-allowed text-[var(--dd-text-muted)]" : "text-[var(--dd-danger)]"}`}
                                disabled={denyReason.trim().length === 0}
                                onClick={submitDeny}
                            >
                                deny
                            </button>
                            <button
                                type="button"
                                className="cursor-pointer text-xs text-[var(--dd-text-muted)]"
                                onClick={() => setDenyOpen(false)}
                            >
                                cancel
                            </button>
                        </div>
                    ) : null}
                </div>

                {!disabled ? (
                    <div className="flex shrink-0 items-center gap-2 text-[11px]">
                        <button
                            type="button"
                            className="cursor-pointer text-[var(--dd-text-muted)] hover:text-[var(--dd-text-primary)]"
                            onClick={() => {
                                setEditText(task.text);
                                setEditCriteria(task.acceptanceCriteria ?? "");
                                setEditing((v) => !v);
                            }}
                            title="edit text / acceptance criteria"
                        >
                            ✎
                        </button>
                        {task.denied ? (
                            <button
                                type="button"
                                className="dd-accent-text cursor-pointer hover:opacity-80"
                                onClick={() => onActions([{ action: "undeny_task", taskId: task.id }])}
                            >
                                undeny
                            </button>
                        ) : (
                            <button
                                type="button"
                                className="cursor-pointer text-[var(--dd-text-muted)] hover:text-[var(--dd-danger)]"
                                onClick={() => setDenyOpen((v) => !v)}
                            >
                                deny
                            </button>
                        )}
                    </div>
                ) : null}
            </div>

            <HandoffProofDialog
                open={proofOpen}
                taskText={task.text}
                onOpenChange={setProofOpen}
                onSubmit={(proof) =>
                    onActions([
                        {
                            action: "check_task",
                            taskId: task.id,
                            proof,
                            ...(task.denied ? { force: true } : {}),
                        },
                    ])
                }
            />
        </div>
    );
}
