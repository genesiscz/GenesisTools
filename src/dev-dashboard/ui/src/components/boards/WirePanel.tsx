import type { AnnotationDto, MessageDto, QuestionDto, RevisionDto } from "@app/dev-dashboard/contract/dto";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import type { ClipboardEvent as ReactClipboardEvent } from "react";
import { useEffect, useState } from "react";
import { STATUS_COLOR } from "./AnnotationLayer";
import { boardsApi } from "./boards-api";
import { CompareDeck } from "./CompareDeck";
import { BoardMarkdown } from "./markdown";

// Attempts render as the CompareDeck (before/after), not a feed row — only revisions +
// messages are merged chronologically here.
type FeedItem =
    | { kind: "revision"; createdAt: string; data: RevisionDto }
    | { kind: "message"; createdAt: string; data: MessageDto };

/** Board-session activity feed: everything that happened on the board, chronological —
 *  messages, annotations (clickable → focus their thread), and question answers. */
type SessionItem =
    | { kind: "message"; createdAt: string; message: MessageDto }
    | { kind: "annotation"; createdAt: string; annotation: AnnotationDto }
    | { kind: "question"; createdAt: string; question: QuestionDto };

function buildFeed(annotation: AnnotationDto): FeedItem[] {
    const items: FeedItem[] = [
        ...annotation.revisions.map((data) => ({ kind: "revision" as const, createdAt: data.createdAt, data })),
        ...annotation.messages.map((data) => ({ kind: "message" as const, createdAt: data.createdAt, data })),
    ];
    // Fixed-width ISO timestamps sort correctly as strings.
    return items.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

function buildSessionFeed(
    messages: MessageDto[],
    annotations: AnnotationDto[],
    questions: QuestionDto[]
): SessionItem[] {
    const items: SessionItem[] = [
        ...messages.map((message) => ({ kind: "message" as const, createdAt: message.createdAt, message })),
        ...annotations.map((annotation) => ({
            kind: "annotation" as const,
            createdAt: annotation.createdAt,
            annotation,
        })),
        ...questions
            .filter((q) => q.answer !== null)
            .map((question) => ({
                kind: "question" as const,
                // answeredAt is "" until answered; fall back to createdAt so it still sorts.
                createdAt: question.answeredAt || question.createdAt,
                question,
            })),
    ];
    return items.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

function formatTime(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function isTypingTarget(target: EventTarget | null): boolean {
    return (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
    );
}

function FeedRow({ item }: { item: FeedItem }) {
    if (item.kind === "message") {
        return (
            <div className="border-b border-[var(--dd-border)]/50 py-2">
                <div className="mb-1 font-mono text-[10px] text-[var(--dd-text-muted)] uppercase">
                    {item.data.author || "unknown"}
                </div>
                <div className="text-sm text-[var(--dd-text-primary)]">
                    <BoardMarkdown md={item.data.body} />
                </div>
            </div>
        );
    }

    return (
        <div className="border-b border-[var(--dd-border)]/50 py-2 text-sm text-[var(--dd-text-secondary)]">
            <span className="font-mono text-[10px] text-[var(--dd-text-muted)] uppercase">
                {item.data.createdBy || "unknown"} revised
            </span>
            <div className="whitespace-pre-wrap">{item.data.prompt}</div>
        </div>
    );
}

function SessionRow({ item, onOpenAnnotation }: { item: SessionItem; onOpenAnnotation: (id: number) => void }) {
    if (item.kind === "message") {
        return <FeedRow item={{ kind: "message", createdAt: item.createdAt, data: item.message }} />;
    }

    if (item.kind === "annotation") {
        const a = item.annotation;
        return (
            <button
                type="button"
                onClick={() => onOpenAnnotation(a.id)}
                className="block w-full border-b border-[var(--dd-border)]/50 py-2 text-left hover:bg-[var(--dd-bg-hover)]"
            >
                <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase">
                    <span
                        className="flex h-4 w-4 items-center justify-center rounded-full border text-[9px] font-bold"
                        style={{ borderColor: STATUS_COLOR[a.status], color: STATUS_COLOR[a.status] }}
                    >
                        {a.id}
                    </span>
                    <span className="text-[var(--dd-text-muted)]">
                        {a.intent === "other" ? a.intentOther || "other" : a.intent}
                    </span>
                    <span style={{ color: STATUS_COLOR[a.status] }}>{a.status}</span>
                    <span className="ml-auto text-[var(--dd-text-muted)]">{a.createdBy || ""}</span>
                </div>
                <div className="truncate text-sm text-[var(--dd-text-primary)]">{a.prompt}</div>
            </button>
        );
    }

    const q = item.question;
    return (
        <div className="border-b border-[var(--dd-border)]/50 py-2 text-sm">
            <div className="mb-1 font-mono text-[10px] text-[var(--dd-text-muted)] uppercase">
                picker {q.staged ? "· staged" : "· sent"}
            </div>
            <div className="text-[var(--dd-text-secondary)]">{q.prompt}</div>
            <div className="text-[var(--dd-text-primary)]">→ {(q.answer ?? []).join(", ")}</div>
        </div>
    );
}

interface WirePanelProps {
    slug: string;
    annotation: AnnotationDto | null;
    annotations: AnnotationDto[];
    questions: QuestionDto[];
    boardMessages: MessageDto[];
    operator: string;
    onSelectAnnotation: (id: number) => void;
    onClose: () => void;
}

/** Right rail: threads for the selected annotation, or the board-level session feed (messages,
 * annotations, picker answers, chronological) when nothing is selected. Quiet-wire style. */
export function WirePanel({
    slug,
    annotation,
    annotations,
    questions,
    boardMessages,
    operator,
    onSelectAnnotation,
    onClose,
}: WirePanelProps) {
    const [draft, setDraft] = useState("");
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const queryClient = useQueryClient();

    useEffect(() => {
        setDraft("");
        setConfirmingDelete(false);
    }, [annotation?.id]);

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape" && !isTypingTarget(e.target)) {
                onClose();
            }
        };

        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [onClose]);

    const invalidate = () => {
        void queryClient.invalidateQueries({ queryKey: ["board", slug] });
    };

    const reviseMutation = useMutation({
        mutationFn: (prompt: string) => boardsApi.reviseAnnotation(annotation?.id ?? -1, prompt),
        onSuccess: invalidate,
        onError: (err) => console.error("[boards] revise annotation failed", err),
    });
    const deleteMutation = useMutation({
        mutationFn: () => boardsApi.deleteAnnotation(annotation?.id ?? -1),
        onSuccess: () => {
            invalidate();
            onClose();
        },
        onError: (err) => console.error("[boards] delete annotation failed", err),
    });
    const cancelMutation = useMutation({
        mutationFn: () => boardsApi.cancelAnnotation(annotation?.id ?? -1),
        onSuccess: invalidate,
        onError: (err) => console.error("[boards] cancel annotation failed", err),
    });
    const reactivateMutation = useMutation({
        mutationFn: () => boardsApi.reactivateAnnotation(annotation?.id ?? -1),
        onSuccess: invalidate,
        onError: (err) => console.error("[boards] reactivate annotation failed", err),
    });
    const reopenMutation = useMutation({
        mutationFn: () => boardsApi.patchAnnotation(annotation?.id ?? -1, { status: "staged" }),
        onSuccess: invalidate,
        onError: (err) => console.error("[boards] reopen annotation failed", err),
    });
    const verdictMutation = useMutation({
        mutationFn: (verdict: "accept" | "reject") => {
            const latest = annotation?.attempts[annotation.attempts.length - 1];
            return boardsApi.verdict(latest?.id ?? -1, verdict);
        },
        onSuccess: invalidate,
        onError: (err) => console.error("[boards] verdict failed", err),
    });
    const replyMutation = useMutation({
        mutationFn: (body: string) => boardsApi.reply(annotation?.id ?? -1, { body, author: operator }),
        onSuccess: invalidate,
        onError: (err) => console.error("[boards] reply failed", err),
    });
    const boardMessageMutation = useMutation({
        mutationFn: (body: string) => boardsApi.boardMessage(slug, { body, author: operator }),
        onSuccess: invalidate,
        onError: (err) => console.error("[boards] board message failed", err),
    });

    const send = () => {
        const body = draft.trim();

        if (!body) {
            return;
        }

        setDraft("");

        if (annotation) {
            replyMutation.mutate(body, { onError: () => setDraft(body) });
        } else {
            boardMessageMutation.mutate(body, { onError: () => setDraft(body) });
        }
    };

    /** Pasted images upload as blobs and land in the draft as markdown — the feed renders
     *  markdown, so the image shows inline wherever the message is read. */
    const onComposerPaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
        const images = [...(e.clipboardData?.items ?? [])]
            .filter((i) => i.type.startsWith("image/"))
            .map((i) => i.getAsFile())
            .filter((f): f is File => f !== null);

        if (images.length === 0) {
            return;
        }

        e.preventDefault();

        for (const [i, file] of images.entries()) {
            // MIME-derived extension + per-item index: same-millisecond multi-image paste must
            // not collide, and a JPEG paste must not masquerade as .png.
            const ext = file.type.startsWith("image/") ? file.type.split("/")[1] : "png";
            void boardsApi
                .uploadMessageImage(slug, file, `reply-${Date.now()}-${i}.${ext}`)
                .then(({ blobKey, name }) => {
                    setDraft(
                        (d) => `${d}${d && !d.endsWith("\n") ? "\n" : ""}![${name}](/api/boards/blobs/${blobKey})\n`
                    );
                })
                .catch((err) => console.error("[boards] reply image upload failed", err));
        }
    };

    const feed = annotation ? buildFeed(annotation) : [];
    const sessionFeed = annotation ? [] : buildSessionFeed(boardMessages, annotations, questions);

    return (
        <div
            data-testid="wire-panel"
            className="flex h-full w-[360px] shrink-0 flex-col border-l border-[var(--dd-border)] bg-[var(--dd-bg-panel)]"
        >
            <div className="flex items-center justify-between border-b border-[var(--dd-border)] px-3 py-2">
                <span className="text-sm font-semibold text-[var(--dd-text-primary)]">
                    {annotation ? `№${annotation.id}` : "board session"}
                </span>
                <button
                    type="button"
                    onClick={onClose}
                    className="text-[var(--dd-text-muted)] hover:text-[var(--dd-text-primary)]"
                >
                    ✕
                </button>
            </div>

            {annotation ? (
                <div className="border-b border-[var(--dd-border)] px-3 py-2 text-xs text-[var(--dd-text-secondary)]">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                        <span className="rounded-full border border-[var(--dd-border)] px-2 py-0.5">
                            {annotation.intent === "other" ? annotation.intentOther || "other" : annotation.intent}
                        </span>
                        <span
                            className="rounded-full border px-2 py-0.5"
                            style={{
                                borderColor: STATUS_COLOR[annotation.status],
                                color: STATUS_COLOR[annotation.status],
                            }}
                        >
                            {annotation.status}
                        </span>
                        <span>
                            {annotation.region.w}×{annotation.region.h}
                        </span>
                        {annotation.status === "staged" ? (
                            <span className="ml-auto">
                                {confirmingDelete ? (
                                    <span className="flex items-center gap-1">
                                        <button
                                            type="button"
                                            onClick={() => deleteMutation.mutate()}
                                            className="rounded bg-[var(--dd-danger)] px-1.5 py-0.5 text-[10px] font-semibold text-white"
                                        >
                                            delete
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setConfirmingDelete(false)}
                                            className="text-[10px] text-[var(--dd-text-muted)] hover:text-[var(--dd-text-primary)]"
                                        >
                                            keep
                                        </button>
                                    </span>
                                ) : (
                                    <button
                                        type="button"
                                        title="delete annotation"
                                        onClick={() => setConfirmingDelete(true)}
                                        className="text-[var(--dd-text-muted)] hover:text-[var(--dd-danger)]"
                                    >
                                        <Trash2 size={13} />
                                    </button>
                                )}
                            </span>
                        ) : null}
                    </div>
                    <div>
                        {annotation.createdBy || "unknown"} · {formatTime(annotation.createdAt)}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                        {annotation.status === "open" || annotation.status === "working" ? (
                            <button type="button" onClick={() => cancelMutation.mutate()} className="hover:underline">
                                cancel
                            </button>
                        ) : null}
                        {annotation.status === "in_review" ? (
                            // Single verdict surface: accept lives here, reject is the CompareDeck's
                            // per-face affordance (which re-stages the thread). A user reply re-stages too.
                            <button
                                type="button"
                                onClick={() => verdictMutation.mutate("accept")}
                                className="text-[var(--dd-accent-from)] hover:underline"
                            >
                                ✓ accept
                            </button>
                        ) : null}
                        {annotation.status === "resolved" ? (
                            <span className="flex items-center gap-2 text-[var(--dd-text-muted)]">
                                resolved —
                                <button
                                    type="button"
                                    onClick={() => reopenMutation.mutate()}
                                    className="hover:underline"
                                >
                                    ↩ reopen to iterate
                                </button>
                            </span>
                        ) : null}
                        {annotation.status === "cancelled" ? (
                            <button
                                type="button"
                                onClick={() => reactivateMutation.mutate()}
                                className="hover:underline"
                            >
                                reactivate
                            </button>
                        ) : null}
                    </div>
                    {annotation.status === "staged" ? (
                        <textarea
                            defaultValue={annotation.prompt}
                            onBlur={(e) => {
                                if (e.target.value.trim() && e.target.value !== annotation.prompt) {
                                    reviseMutation.mutate(e.target.value);
                                }
                            }}
                            rows={2}
                            className="mt-2 w-full resize-none rounded border border-[var(--dd-border)] bg-transparent px-2 py-1 text-[var(--dd-text-primary)] outline-none"
                        />
                    ) : null}
                </div>
            ) : null}

            {annotation && annotation.attempts.length > 0 ? <CompareDeck slug={slug} annotation={annotation} /> : null}

            <div className="min-h-0 flex-1 overflow-y-auto px-3">
                {annotation
                    ? feed.map((item) => <FeedRow key={`${item.kind}-${item.data.id}`} item={item} />)
                    : sessionFeed.map((item) => (
                          <SessionRow
                              key={`${item.kind}-${item.kind === "message" ? item.message.id : item.kind === "annotation" ? item.annotation.id : item.question.id}`}
                              item={item}
                              onOpenAnnotation={onSelectAnnotation}
                          />
                      ))}
            </div>

            <div className="border-t border-[var(--dd-border)] p-2">
                <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onPaste={onComposerPaste}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            send();
                        }
                    }}
                    placeholder="reply... (markdown ok, paste images)"
                    rows={2}
                    className="w-full resize-none rounded border border-[var(--dd-border)] bg-transparent px-2 py-1 text-sm text-[var(--dd-text-primary)] outline-none"
                />
            </div>
        </div>
    );
}
