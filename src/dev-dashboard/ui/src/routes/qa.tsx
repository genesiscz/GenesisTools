import { searchQa } from "@app/dev-dashboard/lib/qa-search";
import { isQaAnswerTruncated } from "@app/dev-dashboard/lib/qa-render";
import type { QaRow } from "@app/dev-dashboard/lib/qa-types";
import { highlightMatchesInHtml } from "@app/utils/ui/helpers/highlight-matches.client";
import { hasNonEmptySelection } from "@app/utils/ui/hooks/useSelectionAware.client";
import { SafeJSON } from "@app/utils/json";
import { useQuery } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QaClockProvider } from "@/components/QaClockProvider";
import { QaCopyButtons } from "@/components/QaCopyButtons";
import { QaRecencyTime } from "@/components/QaRecencyTime";
import { QaSaveToObsidianDialog } from "@/components/QaSaveToObsidianDialog";
import { QaScrollNav } from "@/components/QaScrollNav";
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

const QaCard = memo(function QaCard({
    entry,
    unread,
    wasReadOnLoad,
    viewMode,
    highlightTokens,
    onSeen,
    onUnseen,
}: {
    entry: QaRow;
    unread: boolean;
    wasReadOnLoad: boolean;
    viewMode: QaViewMode;
    highlightTokens: string[];
    onSeen: (id: string) => void;
    onUnseen: (id: string) => void;
}) {
    const [open, setOpen] = useState(!wasReadOnLoad);
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

    const handleCardMouseUp = useCallback(() => {
        if (hasNonEmptySelection()) {
            return;
        }

        setTimeout(() => {
            if (hasNonEmptySelection()) {
                return;
            }

            if (unread) {
                onSeen(entry.id);
            } else {
                onUnseen(entry.id);
            }
        }, 0);
    }, [entry.id, onSeen, onUnseen, unread]);

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
                    <QaCopyButtons entry={entry} onSaveToObsidian={openSave} />
                    <QaRecencyTime ts={entry.ts} />
                </div>
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
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            className="dd-accent-text self-start text-xs"
                            onClick={(ev) => {
                                ev.stopPropagation();
                                setOpen((v) => !v);
                            }}
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
    const initialReadIds = useRef<Set<string> | null>(null);
    const seen = useRef<Set<string>>(new Set());
    const markedReadRef = useRef<Set<string>>(new Set());
    const pendingReadIds = useRef<Set<string>>(new Set());
    const pendingUnreadIds = useRef<Set<string>>(new Set());
    const readFlushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const readApiDisabledRef = useRef(false);

    useEffect(() => {
        if (initialReadIds.current === null && logQuery.data) {
            initialReadIds.current = new Set(logQuery.data.filter((r) => r.readAt != null).map((r) => r.id));
        }
    }, [logQuery.data]);

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
            setSeenIds((prev) => {
                if (prev.has(id)) {
                    return prev;
                }

                const next = new Set(prev);
                next.add(id);
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
                    <div className="flex flex-col gap-3 pr-0 lg:pr-68">
                        {filtered.map((entry) => (
                            <QaCard
                                key={entry.id}
                                entry={entry}
                                unread={!seenIds.has(entry.id)}
                                wasReadOnLoad={initialReadIds.current?.has(entry.id) ?? false}
                                viewMode={viewMode}
                                highlightTokens={highlightTokens}
                                onSeen={markSeen}
                                onUnseen={markUnseen}
                            />
                        ))}
                    </div>
                    <QaScrollNav entries={filtered} seenIds={seenIds} />
                </QaClockProvider>
            )}
        </div>
    );
}
