import { isQaAnswerTruncated } from "@app/dev-dashboard/lib/qa-preview";
import { searchQa } from "@app/dev-dashboard/lib/qa-search";
import type { QaRow } from "@app/dev-dashboard/lib/qa-types";
import { SafeJSON } from "@app/utils/json";
import { highlightMatchesInHtml } from "@app/utils/ui/helpers/highlight-matches.client";
import { useScrollProgress } from "@app/utils/ui/hooks/useScrollProgress.client";
import { hasNonEmptySelection } from "@app/utils/ui/hooks/useSelectionAware.client";
import { useQuery } from "@tanstack/react-query";
import { type KeyboardEvent, type MouseEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QaClockProvider } from "@/components/QaClockProvider";
import { QaCopyButtons } from "@/components/QaCopyButtons";
import { QaReadTime } from "@/components/QaReadTime";
import { QaRecencyTime } from "@/components/QaRecencyTime";
import { QaSaveToObsidianDialog } from "@/components/QaSaveToObsidianDialog";
import { QA_SCROLL_NAV_OFFSET_PX, QaScrollNav } from "@/components/QaScrollNav";
import { QaSearchBox } from "@/components/QaSearchBox";
import { QaSectionHeading } from "@/components/QaSectionHeading";
import { QaSourceToggle, type QaViewMode } from "@/components/QaSourceToggle";
import { QaTopBar } from "@/components/QaTopBar";

const READ_PERSIST_DEBOUNCE_MS = 400;

async function fetchQaLog(): Promise<QaRow[]> {
    const res = await fetch("/api/qa/log?limit=100");

    if (!res.ok) {
        throw new Error(`Failed to load Q&A: ${res.status}`);
    }

    const body = SafeJSON.parse(await res.text(), { strict: true }) as { entries: QaRow[] };

    return body.entries;
}

function tagClass(tag: string): string {
    if (tag === "action") {
        return "border-[#3f5530] text-[#a3e635]";
    }

    if (tag === "directive") {
        return "border-[#4a3a5e] text-[#c792ea]";
    }

    return "border-[var(--dd-border)] text-[var(--dd-text-secondary)]";
}

function truncateMiddle(text: string, maxLen: number): string {
    if (text.length <= maxLen) {
        return text;
    }

    const head = Math.ceil((maxLen - 1) / 2);
    const tail = Math.floor((maxLen - 1) / 2);

    return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function shortSessionId(sessionId: string): string {
    if (sessionId === "unknown" || sessionId.length <= 12) {
        return sessionId;
    }

    return `${sessionId.slice(0, 8)}…`;
}

function QaContextStrip({ entry }: { entry: QaRow }) {
    const commitRef = entry.refs.find((r) => r.type === "commit");
    const hasContext =
        entry.commitSha ||
        entry.commitMessage ||
        entry.isWorktree ||
        entry.cwd ||
        entry.agent !== "unknown" ||
        entry.sessionId !== "unknown" ||
        entry.sessionTitle;

    if (!hasContext) {
        return null;
    }

    const commitLabel = entry.commitSha
        ? `${entry.commitSha}${entry.commitMessage ? ` — ${truncateMiddle(entry.commitMessage, 48)}` : ""}`
        : null;

    return (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-[var(--dd-border)] pt-2 text-[10px] font-mono text-[var(--dd-text-muted)]">
            {commitLabel ? (
                <span title={entry.commitMessage ?? entry.commitSha ?? undefined}>
                    {commitRef ? (
                        <a
                            href={`https://github.com/search?q=${encodeURIComponent(commitRef.value)}&type=commits`}
                            className="dd-accent-text hover:opacity-80"
                            onClick={(ev) => ev.stopPropagation()}
                        >
                            {commitLabel}
                        </a>
                    ) : (
                        <span className="text-[var(--dd-text-secondary)]">{commitLabel}</span>
                    )}
                </span>
            ) : null}
            {entry.isWorktree ? (
                <span
                    className="rounded border border-[var(--dd-border)] px-1.5 py-px text-[var(--dd-text-secondary)]"
                    title={entry.worktreePath ?? entry.cwd}
                >
                    worktree
                    {entry.worktreePath ? `: ${truncateMiddle(entry.worktreePath, 36)}` : ""}
                </span>
            ) : null}
            {entry.cwd ? (
                <span className="max-w-full truncate" title={entry.cwd}>
                    cwd {truncateMiddle(entry.cwd, 42)}
                </span>
            ) : null}
            {entry.agent !== "unknown" || entry.sessionId !== "unknown" ? (
                <span title={entry.sessionId}>
                    {entry.agent !== "unknown" ? entry.agent : "session"}{" "}
                    <span className="text-[var(--dd-text-secondary)]">{shortSessionId(entry.sessionId)}</span>
                </span>
            ) : null}
            {entry.sessionTitle ? (
                <span className="text-[var(--dd-text-secondary)]" title={entry.sessionTitle}>
                    {truncateMiddle(entry.sessionTitle, 40)}
                </span>
            ) : null}
        </div>
    );
}

const QaCard = memo(function QaCard({
    entry,
    unread,
    readAt,
    viewMode,
    highlightTokens,
    onSeen,
    onUnseen,
}: {
    entry: QaRow;
    unread: boolean;
    readAt: number | null;
    viewMode: QaViewMode;
    highlightTokens: string[];
    onSeen: (id: string) => void;
    onUnseen: (id: string) => void;
}) {
    const [open, setOpen] = useState(unread);

    useEffect(() => {
        if (!unread) {
            setOpen(false);
        }
    }, [unread]);
    const [saveDialogOpen, setSaveDialogOpen] = useState(false);
    const truncated = isQaAnswerTruncated(entry.answerMd);
    const answerBase = open || !truncated ? entry.answerHtml : entry.answerHtmlPreview;

    const questionHtml = useMemo(() => {
        if (viewMode === "source") {
            return "";
        }

        const html = entry.questionHtml;

        if (highlightTokens.length === 0) {
            return html;
        }

        return highlightMatchesInHtml(html, highlightTokens);
    }, [entry.questionHtml, highlightTokens, viewMode]);

    const answerHtml = useMemo(() => {
        if (viewMode === "source") {
            return "";
        }

        if (highlightTokens.length === 0) {
            return answerBase;
        }

        return highlightMatchesInHtml(answerBase, highlightTokens);
    }, [answerBase, highlightTokens, viewMode]);

    const handleCardMouseUp = useCallback(
        (ev: MouseEvent) => {
            const target = ev.target as HTMLElement;

            if (target.closest("button") || target.closest("a")) {
                return;
            }

            const nestedButton = target.closest("[role='button']");

            if (nestedButton && nestedButton !== ev.currentTarget) {
                return;
            }

            if (hasNonEmptySelection()) {
                return;
            }

            setTimeout(() => {
                if (hasNonEmptySelection()) {
                    return;
                }

                if (unread) {
                    setOpen(false);
                    onSeen(entry.id);
                } else {
                    onUnseen(entry.id);
                }
            }, 0);
        },
        [entry.id, onSeen, onUnseen, unread]
    );

    const toggleOpen = useCallback((ev: MouseEvent | KeyboardEvent) => {
        ev.stopPropagation();
        setOpen((v) => !v);
    }, []);

    const openSave = (): void => setSaveDialogOpen(true);

    return (
        <>
            <div
                role="button"
                tabIndex={0}
                className={`dd-panel flex flex-col gap-3 p-4${unread ? " dd-qa-card--unread dd-qa-card--clickable" : " dd-qa-card--clickable"}`}
                data-qa-id={entry.id}
                data-qa-unread={unread ? "1" : "0"}
                onMouseUp={handleCardMouseUp}
                onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === " ") {
                        ev.preventDefault();

                        if (unread) {
                            setOpen(false);
                            onSeen(entry.id);
                        } else {
                            onUnseen(entry.id);
                        }
                    }
                }}
            >
                <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--dd-text-muted)]">
                    {unread ? <span className="dd-qa-unread-badge">new</span> : null}
                    <span className="text-[var(--dd-text-secondary)]">{entry.project}</span>
                    <span>·</span>
                    <span>{entry.branch ?? "-"}</span>
                    <span className={`rounded-full border px-2 py-[1px] ${tagClass(entry.tag)}`}>{entry.tag}</span>
                    {truncated ? (
                        <button
                            type="button"
                            className="dd-accent-text cursor-pointer transition-opacity hover:opacity-80"
                            onClick={toggleOpen}
                        >
                            {open ? "Collapse" : "Expand"}
                        </button>
                    ) : null}
                    <QaCopyButtons entry={entry} onSaveToObsidian={openSave} />
                    {!unread && readAt != null ? <QaReadTime readAt={readAt} /> : null}
                    <QaRecencyTime ts={entry.ts} />
                </div>
                <QaContextStrip entry={entry} />
                <QaSectionHeading label="Question" />
                {viewMode === "reading" ? (
                    <article
                        className="dd-qa-section-body dd-markdown font-medium leading-relaxed text-[var(--dd-text-primary)]"
                        dangerouslySetInnerHTML={{ __html: questionHtml }}
                    />
                ) : (
                    <pre className="dd-qa-section-body text-xs whitespace-pre-wrap">{entry.question}</pre>
                )}
                <QaSectionHeading label="Answer" />
                {viewMode === "reading" ? (
                    <article
                        className="dd-qa-section-body dd-markdown text-sm"
                        dangerouslySetInnerHTML={{ __html: answerHtml }}
                    />
                ) : (
                    <pre className="dd-qa-section-body text-xs whitespace-pre-wrap">{entry.answerMd}</pre>
                )}
                {truncated ? (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--dd-text-muted)]">
                        <button
                            type="button"
                            className="dd-accent-text shrink-0 cursor-pointer transition-opacity hover:opacity-80"
                            onClick={toggleOpen}
                        >
                            {open ? "▴ collapse" : "▾ expand full answer (rationale · refs · links)"}
                        </button>
                        <QaCopyButtons entry={entry} onSaveToObsidian={openSave} />
                    </div>
                ) : null}
                {entry.refs.length > 0 ? (
                    <div className="text-xs text-[var(--dd-text-muted)]">
                        refs: {entry.refs.map((r) => `${r.type}:${r.value}`).join(" · ")}
                    </div>
                ) : null}
            </div>
            <QaSaveToObsidianDialog entry={entry} open={saveDialogOpen} onOpenChange={setSaveDialogOpen} />
        </>
    );
});

export function QaRoute() {
    const logQuery = useQuery({ queryKey: ["qa-log"], queryFn: fetchQaLog, retry: false });
    const [live, setLive] = useState<QaRow[]>([]);
    const [sseDown, setSseDown] = useState(false);
    const [seenIds, setSeenIds] = useState<Set<string>>(() => new Set());
    const [viewMode, setViewMode] = useState<QaViewMode>("reading");
    const [query, setQuery] = useState("");
    const [readAtById, setReadAtById] = useState<Map<string, number>>(() => new Map());
    const seen = useRef<Set<string>>(new Set());
    const markedReadRef = useRef<Set<string>>(new Set());
    const pendingReadIds = useRef<Set<string>>(new Set());
    const pendingUnreadIds = useRef<Set<string>>(new Set());
    const readFlushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const readApiDisabledRef = useRef(false);
    const { y: scrollY } = useScrollProgress();

    const flushReadIds = useCallback(() => {
        readFlushTimer.current = undefined;

        if (readApiDisabledRef.current) {
            pendingReadIds.current.clear();
            pendingUnreadIds.current.clear();
            return;
        }

        const readIds = [...pendingReadIds.current];
        const unreadIds = [...pendingUnreadIds.current];
        pendingReadIds.current.clear();
        pendingUnreadIds.current.clear();

        const post = (ids: string[], unread: boolean): void => {
            if (ids.length === 0) {
                return;
            }

            void fetch("/api/qa/read", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify({ ids, unread: unread || undefined }),
            })
                .then((res) => {
                    if (res.status === 404) {
                        readApiDisabledRef.current = true;
                    }
                })
                .catch(() => {
                    /* best-effort */
                });
        };

        post(readIds, false);
        post(unreadIds, true);
    }, []);

    const scheduleFlush = useCallback(() => {
        if (readFlushTimer.current) {
            return;
        }

        readFlushTimer.current = setTimeout(flushReadIds, READ_PERSIST_DEBOUNCE_MS);
    }, [flushReadIds]);

    const markSeen = useCallback(
        (id: string) => {
            if (markedReadRef.current.has(id)) {
                return;
            }

            markedReadRef.current.add(id);
            pendingUnreadIds.current.delete(id);
            const readAt = Date.now();
            setSeenIds((prev) => {
                if (prev.has(id)) {
                    return prev;
                }

                const next = new Set(prev);
                next.add(id);
                return next;
            });
            setReadAtById((prev) => {
                if (prev.has(id)) {
                    return prev;
                }

                const next = new Map(prev);
                next.set(id, readAt);
                return next;
            });
            pendingReadIds.current.add(id);
            scheduleFlush();
        },
        [scheduleFlush]
    );

    const markUnseen = useCallback(
        (id: string) => {
            markedReadRef.current.delete(id);
            pendingReadIds.current.delete(id);
            setSeenIds((prev) => {
                if (!prev.has(id)) {
                    return prev;
                }

                const next = new Set(prev);
                next.delete(id);
                return next;
            });
            setReadAtById((prev) => {
                if (!prev.has(id)) {
                    return prev;
                }

                const next = new Map(prev);
                next.delete(id);
                return next;
            });
            pendingUnreadIds.current.add(id);
            scheduleFlush();
        },
        [scheduleFlush]
    );

    useEffect(() => {
        return () => {
            if (readFlushTimer.current) {
                clearTimeout(readFlushTimer.current);
            }

            flushReadIds();
        };
    }, [flushReadIds]);

    useEffect(() => {
        if (!logQuery.data) {
            return;
        }

        setSeenIds((prev) => {
            const next = new Set(prev);
            let changed = false;

            for (const row of logQuery.data) {
                if (row.readAt != null) {
                    markedReadRef.current.add(row.id);

                    if (!next.has(row.id)) {
                        next.add(row.id);
                        changed = true;
                    }
                }
            }

            return changed ? next : prev;
        });

        setReadAtById((prev) => {
            let next: Map<string, number> | null = null;

            for (const row of logQuery.data) {
                if (row.readAt == null) {
                    continue;
                }

                if (prev.get(row.id) === row.readAt) {
                    continue;
                }

                if (!next) {
                    next = new Map(prev);
                }

                next.set(row.id, row.readAt);
            }

            return next ?? prev;
        });
    }, [logQuery.data]);

    useEffect(() => {
        const es = new EventSource("/api/qa/stream");
        es.onopen = () => setSseDown(false);
        es.onmessage = (ev) => {
            setSseDown(false);

            try {
                const entry = SafeJSON.parse(ev.data, { strict: true }) as QaRow;

                if (seen.current.has(entry.id)) {
                    return;
                }

                seen.current.add(entry.id);
                setLive((prev) => [entry, ...prev]);
            } catch {
                /* ignore malformed frame */
            }
        };
        es.onerror = () => {
            if (es.readyState === EventSource.CLOSED) {
                setSseDown(true);
            }
        };

        return () => es.close();
    }, []);

    if (logQuery.isError) {
        return (
            <div className="dd-panel flex h-[calc(100vh-2rem)] flex-col items-center justify-center gap-2 text-center">
                <p className="text-lg font-bold text-[#f87171]">Failed to load Q&amp;A</p>
                <p className="max-w-sm text-sm text-[var(--dd-text-secondary)]">
                    {logQuery.error instanceof Error ? logQuery.error.message : String(logQuery.error)}
                </p>
            </div>
        );
    }

    const persisted = (logQuery.data ?? []).filter((r) => !seen.current.has(r.id));
    const all = [...live, ...persisted];
    const { entries: filtered, tokens: highlightTokens } = searchQa(all, query);
    const showScrollNav = scrollY >= QA_SCROLL_NAV_OFFSET_PX && filtered.length > 0;

    return (
        <div className="relative flex flex-col gap-4">
            <QaTopBar
                live={!sseDown}
                count={all.length}
                search={<QaSearchBox value={query} onChange={setQuery} />}
                viewToggle={<QaSourceToggle mode={viewMode} onChange={setViewMode} />}
            />

            {logQuery.isLoading ? (
                <div className="dd-panel py-8 text-center text-sm text-[var(--dd-text-muted)]">Loading Q&amp;A…</div>
            ) : filtered.length === 0 ? (
                <div className="dd-panel py-8 text-center text-sm text-[var(--dd-text-muted)]">
                    {all.length === 0 ? "No questions recorded yet." : "No matches for your search."}
                </div>
            ) : (
                <QaClockProvider>
                    <div className={`flex flex-col gap-3${showScrollNav ? " pr-0 lg:pr-68" : ""}`}>
                        {filtered.map((entry) => (
                            <QaCard
                                key={entry.id}
                                entry={entry}
                                unread={!seenIds.has(entry.id)}
                                readAt={readAtById.get(entry.id) ?? entry.readAt}
                                viewMode={viewMode}
                                highlightTokens={highlightTokens}
                                onSeen={markSeen}
                                onUnseen={markUnseen}
                            />
                        ))}
                    </div>
                    <QaScrollNav entries={filtered} seenIds={seenIds} visible={showScrollNav} />
                </QaClockProvider>
            )}
        </div>
    );
}
