import type { AttentionItem } from "@app/dev-dashboard/contract/dto";

interface AttentionRowProps {
    item: AttentionItem;
    onOpenTerminal: (ttydTabId: string) => void;
    onResolve: (qaId: string) => void;
    resolving: boolean;
}

const KIND_LABEL: Record<AttentionItem["kind"], string> = {
    "agent-question": "agent-question",
    "agent-session": "agent-session",
};

/** A short relative time ("now", "5m", "3h", "2d") from an epoch-ms timestamp. */
function relativeTime(ts: number): string {
    if (Number.isNaN(ts)) {
        return "—";
    }

    const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));

    if (sec < 45) {
        return "now";
    }

    const min = Math.round(sec / 60);

    if (min < 60) {
        return `${min}m`;
    }

    const hr = Math.round(min / 60);

    if (hr < 24) {
        return `${hr}h`;
    }

    return `${Math.round(hr / 24)}d`;
}

/**
 * One attention-queue row: a kind pill, the title + subtitle, a relative time, and the primary
 * action — "Open" for an agent session (jumps to /ttyd?tab=<id>) or "Mark read" for a question.
 */
export function AttentionRow({ item, onOpenTerminal, onResolve, resolving }: AttentionRowProps) {
    const isTerminal = item.deepLink.kind === "terminal";
    const pillColor = item.kind === "agent-question" ? "#34d399" : "var(--dd-text-muted)";

    const onAction = () => {
        if (item.deepLink.kind === "terminal") {
            onOpenTerminal(item.deepLink.ttydTabId);
        } else {
            onResolve(item.deepLink.qaId);
        }
    };

    return (
        <div className="flex items-center gap-3 rounded-lg border border-[var(--dd-border)] p-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-center gap-2">
                    <span
                        className="rounded-full border border-[var(--dd-border)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                        style={{ color: pillColor }}
                    >
                        {KIND_LABEL[item.kind]}
                    </span>
                    <span className="text-xs text-[var(--dd-text-muted)]">{relativeTime(item.ts)}</span>
                </div>
                <p className="truncate text-sm font-semibold text-[var(--dd-text-primary)]" title={item.title}>
                    {item.title}
                </p>
                <p className="truncate font-mono text-xs text-[var(--dd-text-secondary)]" title={item.subtitle}>
                    {item.subtitle}
                </p>
            </div>

            <button
                type="button"
                onClick={onAction}
                disabled={resolving}
                className="shrink-0 rounded-md border border-[var(--dd-border)] px-3 py-1.5 text-xs font-medium text-[var(--dd-text-primary)] transition hover:border-[var(--dd-accent)] disabled:opacity-50"
            >
                {isTerminal ? "Open" : resolving ? "…" : "Mark read"}
            </button>
        </div>
    );
}
