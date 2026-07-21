import type {
    HandoffActionInput,
    HandoffActionResult,
    HandoffClaim,
    PublicHandoff,
} from "@app/dev-dashboard/lib/handoff-types";
import { renderMarkdown } from "@app/dev-dashboard/lib/obsidian/markdown";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Textarea } from "@ui/components/textarea";
import { type ClipboardEvent, type DragEvent, useMemo, useRef, useState } from "react";
import { AttachmentStrip, renderWithFileChips } from "./HandoffAttachments";
import { CommitChip, HandoffTaskRow } from "./HandoffTaskRow";
import { actorChipLabel, basename, relativeTime, shortSha, truncateMiddle } from "./handoff-format";
import { uploadHandoffAttachment, useHandoffAction, useHandoffDetail } from "./useHandoffApi";

function md(text: string): string {
    return renderMarkdown(text, { resolveWikilink: () => null }).html;
}

function statusBadgeClass(status: PublicHandoff["status"]): string {
    if (status === "open") {
        return "border-[#3f5530] text-[#a3e635]";
    }

    if (status === "claimed") {
        return "border-[#4a3a5e] text-[#c792ea]";
    }

    if (status === "done") {
        return "border-[var(--dd-border)] text-[var(--dd-text-muted)]";
    }

    return "border-[var(--dd-danger)]/50 text-[var(--dd-danger)]";
}

function ClaimerRow({ claim }: { claim: HandoffClaim }) {
    const [expanded, setExpanded] = useState(false);
    const [cwdExpanded, setCwdExpanded] = useState(false);

    return (
        <div className="flex flex-col gap-1 rounded border border-[#4a3a5e]/40 bg-black/10 px-2 py-1.5">
            <button
                type="button"
                className="flex w-full cursor-pointer items-center gap-1.5 text-left"
                onClick={() => setExpanded((v) => !v)}
            >
                <span className="rounded-full border border-[#4a3a5e] px-2 py-px text-[11px] text-[#c792ea]">
                    {claim.sessionName ?? claim.sessionId ?? "unnamed"}
                </span>
                <span className="text-[10px] text-[var(--dd-text-muted)]">{expanded ? "▴" : "▾"}</span>
            </button>
            {expanded ? (
                <div className="flex flex-col gap-1 pl-1 font-mono text-[10px] text-[var(--dd-text-secondary)]">
                    {claim.branch !== null ? <span>branch: {claim.branch}</span> : null}
                    {claim.repoRoot !== null ? <span>repo: {basename(claim.repoRoot)}</span> : null}
                    {claim.commitSha !== null ? (
                        <span className="flex items-center gap-1.5">
                            sha:
                            <CommitChip sha={claim.commitSha} label={shortSha(claim.commitSha)} />
                        </span>
                    ) : null}
                    {claim.cwd !== null ? (
                        <button
                            type="button"
                            className="cursor-pointer text-left hover:text-[var(--dd-text-primary)]"
                            onClick={() => setCwdExpanded((v) => !v)}
                            title="click to expand"
                        >
                            cwd: {cwdExpanded ? claim.cwd : truncateMiddle(claim.cwd, 48)}
                        </button>
                    ) : null}
                    <span>claimed {relativeTime(claim.claimedAt)}</span>
                </div>
            ) : null}
        </div>
    );
}

export function HandoffDetail({ id }: { id: string }) {
    const detail = useHandoffDetail(id);
    const action = useHandoffAction(id);
    const [editIdRevealed, setEditIdRevealed] = useState(false);
    const [editingTitle, setEditingTitle] = useState(false);
    const [titleDraft, setTitleDraft] = useState("");
    const [editingDescription, setEditingDescription] = useState(false);
    const [descriptionDraft, setDescriptionDraft] = useState("");
    const [newTaskText, setNewTaskText] = useState("");
    const [newTaskCriteria, setNewTaskCriteria] = useState("");
    const [commentDraft, setCommentDraft] = useState("");
    const [pendingFiles, setPendingFiles] = useState<File[]>([]);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const composerRef = useRef<HTMLTextAreaElement | null>(null);
    const handoff = detail.data?.handoff;
    const lastResults: HandoffActionResult[] = action.data?.results ?? [];
    const failures = lastResults.filter((r) => !r.ok);

    const descriptionHtml = useMemo(
        () => (handoff?.description !== undefined ? md(handoff.description) : ""),
        [handoff?.description]
    );

    if (detail.isLoading || handoff === undefined) {
        return (
            <div className="dd-panel flex h-40 items-center justify-center text-sm text-[var(--dd-text-muted)]">
                {detail.isError ? `Failed to load: ${String(detail.error)}` : "Loading handoff…"}
            </div>
        );
    }

    const terminal = handoff.status === "done" || handoff.status === "cancelled";
    const resolved = handoff.tasks.filter((t) => t.checked || t.denied).length;
    const allResolved = handoff.tasks.length > 0 && resolved === handoff.tasks.length;
    // Owner-claim detection mirrors fold G11: the human owner's claim identity is agent === "human".
    const humanClaim = handoff.claimedBy.find((c) => c.agent === "human");
    const run = (actions: HandoffActionInput[]): void => action.mutate(actions);

    const pasteFileIntoTask = async (file: File, taskId: string): Promise<string> => {
        const res = await uploadHandoffAttachment({ id, file, taskId });
        void detail.refetch();
        return res.attachmentId;
    };

    const uploadFiles = (files: File[], taskId?: string): void => {
        setUploadError(null);

        Promise.allSettled(files.map((file) => uploadHandoffAttachment({ id, file, taskId }))).then((results) => {
            const failure = results.find((r): r is PromiseRejectedResult => r.status === "rejected");

            if (failure !== undefined) {
                setUploadError(failure.reason instanceof Error ? failure.reason.message : String(failure.reason));
            }

            void detail.refetch();
        });
    };

    /**
     * Paste into a text composer (new-task or comment) → upload the file(s) at handoff
     * level and insert `[File#id]` at the cursor, so the ref renders as an inline chip
     * (same pattern as editing an existing task's text). stopPropagation keeps the
     * container paste handler from also grabbing the file.
     */
    const pasteFilesIntoDraft = (
        ev: ClipboardEvent<HTMLTextAreaElement>,
        setDraft: (updater: (prev: string) => string) => void
    ): void => {
        const files = [...ev.clipboardData.files];

        if (files.length === 0) {
            return;
        }

        ev.preventDefault();
        ev.stopPropagation();
        setUploadError(null);
        const el = ev.target as HTMLTextAreaElement;
        const cursor = el.selectionStart ?? el.value.length;

        Promise.all(files.map((file) => uploadHandoffAttachment({ id, file }))).then(
            (uploads) => {
                const tokens = uploads.map((u) => `[File#${u.attachmentId}]`).join(" ");
                setDraft((prev) => `${prev.slice(0, cursor)}${tokens}${prev.slice(cursor)}`);
                void detail.refetch();
            },
            (err) => setUploadError(err instanceof Error ? err.message : String(err))
        );
    };

    /** Paste anywhere (§7.3): task-row focus → that task; comment composer → pending chip; else the handoff. */
    const onPaste = (ev: ClipboardEvent<HTMLDivElement>): void => {
        const files = [...ev.clipboardData.files];

        if (files.length === 0) {
            return;
        }

        ev.preventDefault();
        const target = ev.target as HTMLElement;

        if (target.closest("[data-comment-composer]") !== null) {
            setPendingFiles((prev) => [...prev, ...files]);
            return;
        }

        const taskRow = target.closest("[data-task-id]");
        uploadFiles(files, taskRow?.getAttribute("data-task-id") ?? undefined);
    };

    const onDrop = (ev: DragEvent<HTMLDivElement>): void => {
        const files = [...ev.dataTransfer.files];

        if (files.length === 0) {
            return;
        }

        ev.preventDefault();
        const target = ev.target as HTMLElement;

        if (target.closest("[data-comment-composer]") !== null) {
            setPendingFiles((prev) => [...prev, ...files]);
            return;
        }

        const taskRow = target.closest("[data-task-id]");
        uploadFiles(files, taskRow?.getAttribute("data-task-id") ?? undefined);
    };

    const submitComment = async (): Promise<void> => {
        const text = commentDraft.trim();

        if (text.length === 0 && pendingFiles.length === 0) {
            return;
        }

        setUploadError(null);

        try {
            const attachmentIds: string[] = [];

            for (const file of pendingFiles) {
                const res = await uploadHandoffAttachment({ id, file });
                attachmentIds.push(res.attachmentId);
            }

            run([
                {
                    action: "comment",
                    text: text.length > 0 ? text : "(attachment)",
                    ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
                },
            ]);
            setCommentDraft("");
            setPendingFiles([]);
        } catch (err) {
            setUploadError(err instanceof Error ? err.message : String(err));
        }
    };

    const handoffLevelAttachments = handoff.attachments.filter(
        (a) =>
            a.taskId === undefined && !handoff.comments.some((c) => c.attachmentIds?.includes(a.attachmentId) === true)
    );

    return (
        <div
            className="dd-panel flex flex-col gap-4 p-4"
            onPaste={onPaste}
            onDrop={onDrop}
            onDragOver={(ev) => ev.preventDefault()}
        >
            <div className="flex flex-wrap items-center gap-2">
                {editingTitle ? (
                    <div className="flex flex-1 items-center gap-2">
                        <Input
                            value={titleDraft}
                            onChange={(e) => setTitleDraft(e.target.value)}
                            className="border-[var(--dd-border)] bg-black/25 text-base font-bold"
                        />
                        <button
                            type="button"
                            className="dd-accent-text cursor-pointer text-xs"
                            onClick={() => {
                                if (titleDraft.trim().length > 0 && titleDraft !== handoff.title) {
                                    run([{ action: "modify_handoff", title: titleDraft }]);
                                }

                                setEditingTitle(false);
                            }}
                        >
                            save
                        </button>
                        <button
                            type="button"
                            className="cursor-pointer text-xs text-[var(--dd-text-muted)]"
                            onClick={() => setEditingTitle(false)}
                        >
                            cancel
                        </button>
                    </div>
                ) : (
                    <h2 className="flex-1 text-base font-bold text-[var(--dd-text-primary)]">
                        {handoff.title}
                        {!terminal ? (
                            <button
                                type="button"
                                className="ml-2 cursor-pointer text-xs text-[var(--dd-text-muted)] transition-colors hover:text-[var(--dd-text-primary)]"
                                onClick={() => {
                                    setTitleDraft(handoff.title);
                                    setEditingTitle(true);
                                }}
                                title="edit title"
                            >
                                ✎
                            </button>
                        ) : null}
                    </h2>
                )}
                <span
                    className={`rounded-full border px-2 py-[1px] font-mono text-[11px] uppercase ${statusBadgeClass(handoff.status)}`}
                >
                    {handoff.status}
                </span>
            </div>

            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-[var(--dd-text-muted)]">
                <span className="text-[var(--dd-text-secondary)]">{handoff.id}</span>
                <span>·</span>
                <span>by {handoff.postedBy.sessionName ?? handoff.postedBy.sessionId ?? handoff.postedBy.agent}</span>
                {handoff.project !== null ? (
                    <>
                        <span>·</span>
                        <span>{handoff.project}</span>
                    </>
                ) : null}
                <span>·</span>
                <span>
                    {resolved}/{handoff.tasks.length} resolved
                </span>
                <span>·</span>
                {editIdRevealed && detail.data?.editId !== undefined ? (
                    <button
                        type="button"
                        className="dd-accent-text cursor-pointer hover:opacity-80"
                        onClick={() => {
                            navigator.clipboard
                                .writeText(detail.data?.editId ?? "")
                                .catch((err) => console.error("copy editId failed", err));
                        }}
                        title="click to copy"
                    >
                        {detail.data.editId} ⧉
                    </button>
                ) : (
                    <button
                        type="button"
                        className="cursor-pointer transition-colors hover:text-[var(--dd-text-primary)]"
                        onClick={() => setEditIdRevealed(true)}
                        title="reveal the poster edit credential"
                    >
                        editId ••••••
                    </button>
                )}
            </div>

            {handoff.claimedBy.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--dd-text-muted)]">
                        claimed by
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                        {handoff.claimedBy.map((c) => (
                            <ClaimerRow key={`${c.sessionId}-${c.claimedAt}`} claim={c} />
                        ))}
                    </div>
                </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
                {!terminal ? (
                    <>
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={action.isPending}
                            className="border-[#4a3a5e] text-[#c792ea] transition-[filter] hover:brightness-110"
                            onClick={() => run([{ action: humanClaim !== undefined ? "unclaim" : "claim" }])}
                        >
                            {humanClaim !== undefined ? "Unclaim" : "Claim"}
                        </Button>
                        <Button
                            size="sm"
                            disabled={action.isPending}
                            className="transition-[filter] hover:brightness-110"
                            onClick={() => {
                                if (
                                    allResolved ||
                                    window.confirm(`${handoff.tasks.length - resolved} open task(s) — force finish?`)
                                ) {
                                    run([{ action: "finish_handoff", ...(allResolved ? {} : { force: true }) }]);
                                }
                            }}
                        >
                            Finish
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={action.isPending}
                            className="border-[var(--dd-border)] text-[var(--dd-danger)] hover:border-[var(--dd-danger)]/60"
                            onClick={() => {
                                if (window.confirm("Cancel this handoff? Claimers will be told to stop work.")) {
                                    run(["cancel_handoff"]);
                                }
                            }}
                        >
                            Cancel
                        </Button>
                    </>
                ) : (
                    <Button size="sm" disabled={action.isPending} onClick={() => run(["reopen_handoff"])}>
                        Reopen
                    </Button>
                )}
            </div>

            {handoff.description !== undefined ? (
                <div>
                    <div className="mb-1 flex items-center gap-2">
                        <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--dd-text-muted)]">
                            description
                        </span>
                        {!terminal && !editingDescription ? (
                            <button
                                type="button"
                                className="cursor-pointer text-xs text-[var(--dd-text-muted)] transition-colors hover:text-[var(--dd-text-primary)]"
                                onClick={() => {
                                    setDescriptionDraft(handoff.description ?? "");
                                    setEditingDescription(true);
                                }}
                            >
                                ✎
                            </button>
                        ) : null}
                    </div>
                    {editingDescription ? (
                        <div className="flex flex-col gap-1.5">
                            <Textarea
                                value={descriptionDraft}
                                onChange={(e) => setDescriptionDraft(e.target.value)}
                                className="border-[var(--dd-border)] bg-black/25 text-sm"
                                rows={4}
                            />
                            <div className="flex gap-2 text-xs">
                                <button
                                    type="button"
                                    className="dd-accent-text cursor-pointer"
                                    onClick={() => {
                                        run([{ action: "modify_handoff", description: descriptionDraft }]);
                                        setEditingDescription(false);
                                    }}
                                >
                                    save
                                </button>
                                <button
                                    type="button"
                                    className="cursor-pointer text-[var(--dd-text-muted)]"
                                    onClick={() => setEditingDescription(false)}
                                >
                                    cancel
                                </button>
                            </div>
                        </div>
                    ) : (
                        <article
                            className="dd-markdown text-sm text-[var(--dd-text-secondary)]"
                            dangerouslySetInnerHTML={{ __html: descriptionHtml }}
                        />
                    )}
                </div>
            ) : null}

            {handoff.refs !== undefined && handoff.refs.length > 0 ? (
                <div className="font-mono text-[10px] text-[var(--dd-text-muted)]">
                    refs: {handoff.refs.join(" · ")}
                </div>
            ) : null}

            <AttachmentStrip attachments={handoffLevelAttachments} />

            <div className="flex flex-col gap-1.5">
                <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--dd-text-muted)]">
                    tasks
                </span>
                {handoff.tasks.map((task) => (
                    <HandoffTaskRow
                        key={task.id}
                        task={task}
                        attachments={handoff.attachments}
                        disabled={terminal || action.isPending}
                        onActions={run}
                        onPasteFile={(file) => pasteFileIntoTask(file, task.id)}
                    />
                ))}
                {!terminal ? (
                    <div className="flex flex-col gap-1.5 rounded border border-dashed border-[var(--dd-border)]/60 px-3 py-2">
                        <Textarea
                            value={newTaskText}
                            onChange={(e) => setNewTaskText(e.target.value)}
                            onPaste={(e) => pasteFilesIntoDraft(e, setNewTaskText)}
                            className="min-h-[2rem] border-[var(--dd-border)] bg-black/15 text-sm"
                            rows={2}
                            placeholder="add a task… (paste an image to insert a [File#id] ref)"
                        />
                        <div className="flex items-center gap-2">
                            <Input
                                value={newTaskCriteria}
                                onChange={(e) => setNewTaskCriteria(e.target.value)}
                                className="h-7 border-[var(--dd-border)] bg-black/10 text-xs"
                                placeholder="acceptance criteria (optional)"
                                onKeyDown={(e) => {
                                    if (e.key !== "Enter" || newTaskText.trim().length === 0) {
                                        return;
                                    }

                                    e.preventDefault();
                                    run([
                                        {
                                            action: "add_tasks",
                                            tasks: [
                                                {
                                                    text: newTaskText.trim(),
                                                    ...(newTaskCriteria.trim().length > 0
                                                        ? { acceptanceCriteria: newTaskCriteria.trim() }
                                                        : {}),
                                                },
                                            ],
                                        },
                                    ]);
                                    setNewTaskText("");
                                    setNewTaskCriteria("");
                                }}
                            />
                            <Button
                                size="sm"
                                variant="outline"
                                disabled={newTaskText.trim().length === 0 || action.isPending}
                                onClick={() => {
                                    run([
                                        {
                                            action: "add_tasks",
                                            tasks: [
                                                {
                                                    text: newTaskText.trim(),
                                                    ...(newTaskCriteria.trim().length > 0
                                                        ? { acceptanceCriteria: newTaskCriteria.trim() }
                                                        : {}),
                                                },
                                            ],
                                        },
                                    ]);
                                    setNewTaskText("");
                                    setNewTaskCriteria("");
                                }}
                            >
                                Add
                            </Button>
                        </div>
                    </div>
                ) : null}
            </div>

            <div className="flex flex-col gap-2">
                <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--dd-text-muted)]">
                    comments
                </span>
                {handoff.comments.length === 0 ? (
                    <p className="text-xs text-[var(--dd-text-muted)]">No comments yet.</p>
                ) : (
                    handoff.comments.map((comment) => (
                        <div
                            key={`${comment.ts}-${comment.text.slice(0, 24)}`}
                            className="rounded border border-[var(--dd-border)]/50 bg-black/10 px-3 py-2"
                        >
                            <div className="mb-1 flex items-center gap-2 font-mono text-[10px] text-[var(--dd-text-muted)]">
                                <span className="text-[var(--dd-text-secondary)]">{actorChipLabel(comment.by)}</span>
                                <span>{new Date(comment.ts).toLocaleString()}</span>
                            </div>
                            <div className="dd-markdown text-sm text-[var(--dd-text-primary)]">
                                {renderWithFileChips(comment.text, handoff.attachments, (segment, key) => (
                                    <span key={key} dangerouslySetInnerHTML={{ __html: md(segment) }} />
                                ))}
                            </div>
                            {comment.attachmentIds !== undefined && comment.attachmentIds.length > 0 ? (
                                <div className="mt-1.5">
                                    <AttachmentStrip attachments={handoff.attachments} ids={comment.attachmentIds} />
                                </div>
                            ) : null}
                        </div>
                    ))
                )}
                {!terminal ? (
                    <div data-comment-composer className="flex flex-col gap-1.5">
                        {pendingFiles.length > 0 ? (
                            <div className="flex flex-wrap gap-1.5">
                                {pendingFiles.map((file, index) => (
                                    <span
                                        key={index}
                                        className="inline-flex items-center gap-1 rounded border border-primary/40 bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-[var(--dd-text-secondary)]"
                                    >
                                        📎 {file.name || "pasted image"}
                                        <button
                                            type="button"
                                            className="cursor-pointer hover:text-[var(--dd-danger)]"
                                            onClick={() =>
                                                setPendingFiles((prev) => prev.filter((_, i) => i !== index))
                                            }
                                        >
                                            ×
                                        </button>
                                    </span>
                                ))}
                            </div>
                        ) : null}
                        <div className="flex items-end gap-2">
                            <Textarea
                                ref={composerRef}
                                value={commentDraft}
                                onChange={(e) => setCommentDraft(e.target.value)}
                                onPaste={(e) => pasteFilesIntoDraft(e, setCommentDraft)}
                                className="min-h-[2.5rem] border-[var(--dd-border)] bg-black/15 text-sm"
                                rows={2}
                                placeholder="comment… (paste an image to insert a [File#id] ref, ⌘⏎ to send)"
                                onKeyDown={(e) => {
                                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                                        e.preventDefault();
                                        void submitComment();
                                    }
                                }}
                            />
                            <Button
                                size="sm"
                                disabled={
                                    (commentDraft.trim().length === 0 && pendingFiles.length === 0) || action.isPending
                                }
                                onClick={() => void submitComment()}
                            >
                                Send
                            </Button>
                        </div>
                    </div>
                ) : null}
            </div>

            {failures.length > 0 ? (
                <div className="rounded border border-[var(--dd-danger)]/40 bg-[var(--dd-danger)]/10 px-3 py-2 text-xs text-[var(--dd-danger)]">
                    {failures.map((f) => (
                        <p key={`${f.action}-${f.error}`}>
                            {f.action}: {f.error}
                        </p>
                    ))}
                </div>
            ) : null}
            {uploadError !== null ? <p className="text-xs text-[var(--dd-danger)]">{uploadError}</p> : null}
            {action.isError ? <p className="text-xs text-[var(--dd-danger)]">{String(action.error)}</p> : null}
            {detail.data !== undefined && detail.data.info.length > 0 ? (
                <p className="font-mono text-[10px] text-[var(--dd-text-muted)]">{detail.data.info.join(" · ")}</p>
            ) : null}
        </div>
    );
}
