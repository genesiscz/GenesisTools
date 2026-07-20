import type { HandoffPublicEvent } from "@app/dev-dashboard/lib/handoff-types";
import { ChevronsRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useActivityPanel } from "@/hooks/useActivityPanel";
import { fetchHandoffEvents, useHandoffEvents } from "@/hooks/useHandoffEvents";
import { actorChipLabel, relativeTime } from "./handoff-format";

const VERB_COLOR: Record<string, string> = {
    post: "#60a5fa",
    claim: "#22d3ee",
    unclaim: "#22d3ee",
    check_task: "#4ade80",
    uncheck_task: "#4ade80",
    deny_task: "#fbbf24",
    undeny_task: "#fbbf24",
    comment: "var(--dd-text-secondary)",
    attach: "var(--dd-text-secondary)",
    add_tasks: "#c792ea",
    modify_task: "#c792ea",
    modify_handoff: "#c792ea",
    finish: "#facc15",
    cancel: "var(--dd-text-muted)",
    reopen: "#22d3ee",
};

function str(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function field(value: unknown, key: string): unknown {
    if (typeof value !== "object" || value === null || !(key in value)) {
        return undefined;
    }

    return (value as Record<string, unknown>)[key];
}

function describeEvent(event: HandoffPublicEvent): string {
    const taskId = str(field(event, "taskId"));

    switch (event.ev) {
        case "post":
            return "posted the handoff";
        case "claim":
            return "claimed the handoff";
        case "unclaim":
            return "released the claim";
        case "check_task":
            return `checked ${taskId ?? "a task"}`;
        case "uncheck_task":
            return `unchecked ${taskId ?? "a task"}`;
        case "deny_task": {
            const reason = str(field(event, "reason"));
            return `denied ${taskId ?? "a task"}${reason !== undefined ? ` — ${reason}` : ""}`;
        }
        case "undeny_task":
            return `un-denied ${taskId ?? "a task"}`;
        case "comment":
            return "commented";
        case "attach":
            return `attached ${str(field(event, "filename")) ?? "a file"}`;
        case "add_tasks": {
            const tasksField = field(event, "tasks");
            const tasks = Array.isArray(tasksField) ? tasksField.length : undefined;
            return `added ${tasks ?? ""} task${tasks === 1 ? "" : "s"}`.trim();
        }
        case "modify_task":
            return `modified ${taskId ?? "a task"}`;
        case "modify_handoff":
            return "modified the handoff";
        case "finish":
            return "finished the handoff";
        case "cancel":
            return "cancelled the handoff";
        case "reopen":
            return "reopened the handoff";
        default:
            return event.ev;
    }
}

function eventDetail(event: HandoffPublicEvent): string | null {
    switch (event.ev) {
        case "check_task":
            return str(field(field(event, "proof"), "answer")) ?? null;
        case "deny_task":
            return str(field(event, "reason")) ?? null;
        case "comment":
            return str(field(event, "text")) ?? null;
        case "modify_task": {
            const parts: string[] = [];
            const text = str(field(event, "text"));
            const criteria = str(field(event, "acceptanceCriteria"));

            if (text !== undefined) {
                parts.push(`text: ${text}`);
            }

            if (criteria !== undefined) {
                parts.push(`criteria: ${criteria}`);
            }

            return parts.length > 0 ? parts.join("\n") : null;
        }
        case "modify_handoff": {
            const title = str(field(event, "title"));
            const description = str(field(event, "description"));
            const parts: string[] = [];

            if (title !== undefined) {
                parts.push(`title: ${title}`);
            }

            if (description !== undefined) {
                parts.push(`description: ${description}`);
            }

            return parts.length > 0 ? parts.join("\n") : null;
        }
        case "attach": {
            const mime = str(field(event, "mime"));
            return mime !== undefined ? `mime: ${mime}` : null;
        }
        default:
            return null;
    }
}

function EventEntry({ event, index }: { event: HandoffPublicEvent; index: number }) {
    const [expanded, setExpanded] = useState(false);
    const color = VERB_COLOR[event.ev] ?? "var(--dd-text-muted)";
    const detail = eventDetail(event);

    return (
        <div
            className="dd-activity-entry flex flex-col gap-1 rounded border-l-2 bg-black/10 px-2.5 py-2 text-[11px] transition-colors duration-150 hover:bg-black/20"
            style={{ borderLeftColor: color, animationDelay: `${Math.min(index, 10) * 24}ms` }}
        >
            <div className="flex items-center gap-2">
                <span className="shrink-0 rounded-full border border-[var(--dd-border)] px-1.5 py-px font-mono text-[10px] text-[var(--dd-text-secondary)]">
                    {actorChipLabel(event.by)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[var(--dd-text-primary)]">{describeEvent(event)}</span>
                <span className="shrink-0 font-mono text-[10px] text-[var(--dd-text-muted)]">
                    {relativeTime(event.ts)}
                </span>
            </div>
            {detail !== null ? (
                <>
                    <button
                        type="button"
                        className="cursor-pointer self-start font-mono text-[10px] text-[var(--dd-text-muted)] hover:text-[var(--dd-text-primary)]"
                        onClick={() => setExpanded((v) => !v)}
                    >
                        {expanded ? "▴ details" : "▾ details"}
                    </button>
                    {expanded ? (
                        <p className="whitespace-pre-wrap rounded border border-[var(--dd-border)]/50 bg-black/20 p-1.5 text-[var(--dd-text-secondary)]">
                            {detail}
                        </p>
                    ) : null}
                </>
            ) : null}
        </div>
    );
}

export function ActivityPanel({ id }: { id: string | null }) {
    const panel = useActivityPanel();
    const collapsed = panel.state === "collapsed";
    const events = useHandoffEvents(id);
    const [olderEvents, setOlderEvents] = useState<HandoffPublicEvent[]>([]);
    const [loadingMore, setLoadingMore] = useState(false);
    const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

    useEffect(() => {
        setOlderEvents([]);
        setLoadMoreError(null);
    }, [id]);

    const firstPage = events.data?.events ?? [];
    const total = events.data?.total ?? 0;
    const seen = new Set(firstPage.map((e) => e.uid));
    const allEvents = [...firstPage, ...olderEvents.filter((e) => !seen.has(e.uid))];
    const hasMore = allEvents.length < total;

    const loadMore = (): void => {
        if (id === null || allEvents.length === 0 || loadingMore) {
            return;
        }

        const oldest = allEvents[allEvents.length - 1];
        setLoadingMore(true);
        setLoadMoreError(null);

        fetchHandoffEvents({ id, before: oldest.ts })
            .then((res) => setOlderEvents((prev) => [...prev, ...res.events]))
            .catch((err) => setLoadMoreError(err instanceof Error ? err.message : String(err)))
            .finally(() => setLoadingMore(false));
    };

    if (collapsed) {
        return (
            <button
                type="button"
                className="dd-panel flex w-full flex-col items-center justify-start gap-2 self-start py-3 transition-colors duration-150 hover:border-primary/40 lg:h-full"
                onClick={() => panel.setState("expanded")}
                title="expand activity"
            >
                <span className="[writing-mode:vertical-rl] font-mono text-[10px] uppercase tracking-wider text-[var(--dd-text-muted)]">
                    Activity
                </span>
                {total > 0 ? (
                    <span className="rounded-full border border-[var(--dd-border)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--dd-text-secondary)]">
                        {total}
                    </span>
                ) : null}
            </button>
        );
    }

    return (
        <div className="dd-panel flex min-h-0 flex-col gap-2 self-start p-3 lg:h-full">
            <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--dd-text-muted)]">
                    Activity{total > 0 ? ` · ${total}` : ""}
                </span>
                <button
                    type="button"
                    className="cursor-pointer text-[var(--dd-text-muted)] transition-colors hover:text-[var(--dd-text-primary)]"
                    onClick={() => panel.setState("collapsed")}
                    title="collapse activity"
                >
                    <ChevronsRight className="h-3.5 w-3.5" />
                </button>
            </div>
            {id === null ? (
                <p className="py-6 text-center text-xs text-[var(--dd-text-muted)]">
                    Select a handoff to see its activity.
                </p>
            ) : events.isLoading ? (
                <p className="py-6 text-center text-xs text-[var(--dd-text-muted)]">Loading…</p>
            ) : events.isError ? (
                <p className="py-6 text-center text-xs text-[var(--dd-danger)]">{String(events.error)}</p>
            ) : allEvents.length === 0 ? (
                <p className="py-6 text-center text-xs text-[var(--dd-text-muted)]">No activity yet.</p>
            ) : (
                <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
                    {allEvents.map((event, index) => (
                        <EventEntry key={event.uid} event={event} index={index} />
                    ))}
                    {hasMore ? (
                        <button
                            type="button"
                            disabled={loadingMore}
                            className="cursor-pointer self-center font-mono text-[10px] text-[var(--dd-text-muted)] hover:text-[var(--dd-text-primary)] disabled:cursor-not-allowed"
                            onClick={loadMore}
                        >
                            {loadingMore ? "loading…" : "load more"}
                        </button>
                    ) : null}
                    {loadMoreError !== null ? (
                        <p className="text-center text-[10px] text-[var(--dd-danger)]">{loadMoreError}</p>
                    ) : null}
                </div>
            )}
        </div>
    );
}
