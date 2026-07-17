import { ActivityGraph } from "@app/utils/ui/components/youtube/activity-graph";
import { formatLedgerReason } from "@app/utils/ui/components/youtube/ledger-copy";
import { formatRelativeTime } from "@app/utils/ui/components/youtube/time";
import { type LedgerRowData, ledgerReasonGroup } from "@app/youtube/lib/types";
import { useLedger, useUsageSummary } from "@ext/api.hooks";
import { ArrowLeft, Gem, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Full activity view swapped into the panel body in place of the video
 * tabs (VideoPanel owns the `view` state and the shared Header/settings
 * chrome — see side-panel.tsx). No standalone "back-chevron" component
 * existed to mirror (the channel/playlist panels expose no dismiss
 * affordance) — the back row here is a fresh, capsule-consistent pattern
 * (ArrowLeft + "Back", matching Feature 11's PresetEditor block).
 */
export function ActivityView({ onBack }: { onBack?: () => void }) {
    const summary = useUsageSummary();
    const ledger = useLedger();
    const [selectedReasons, setSelectedReasons] = useState<Set<string>>(new Set());
    const [selectedDate, setSelectedDate] = useState<string | null>(null);
    const sentinelRef = useRef<HTMLDivElement | null>(null);

    const allRows = useMemo(() => ledger.data?.pages.flatMap((page) => page.rows) ?? [], [ledger.data]);
    const filteredRows = allRows.filter((row) => {
        if (selectedReasons.size > 0 && !selectedReasons.has(ledgerReasonGroup(row.reason))) {
            return false;
        }

        if (selectedDate !== null && row.createdAt.slice(0, 10) !== selectedDate) {
            return false;
        }

        return true;
    });

    useEffect(() => {
        const sentinel = sentinelRef.current;

        if (!sentinel) {
            return;
        }

        // The panel scrolls inside `.yt-scroll`, not the window — an
        // IntersectionObserver with the default (viewport) root never fires
        // for a sentinel inside a nested scroll container.
        const root = sentinel.closest<HTMLElement>(".yt-scroll") ?? null;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0]?.isIntersecting && ledger.hasNextPage && !ledger.isFetchingNextPage) {
                    ledger.fetchNextPage();
                }
            },
            { root }
        );

        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [ledger.hasNextPage, ledger.isFetchingNextPage, ledger.fetchNextPage]);

    function toggleReason(reason: string): void {
        setSelectedReasons((prev) => {
            const next = new Set(prev);

            if (next.has(reason)) {
                next.delete(reason);
            } else {
                next.add(reason);
            }

            return next;
        });
    }

    return (
        <div className="space-y-4 p-4">
            {onBack ? (
                <button
                    type="button"
                    onClick={onBack}
                    className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                    <ArrowLeft className="size-4" /> Back
                </button>
            ) : null}

            <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">activity</p>
                <p className="mt-1 text-sm text-muted-foreground">
                    This month:{" "}
                    <span className="font-semibold tabular-nums text-foreground">
                        {summary.data?.month.spent ?? 0} 💎
                    </span>{" "}
                    spent · +{summary.data?.month.earned ?? 0} topped up
                </p>
            </div>

            <ActivityGraph
                days={summary.data?.days ?? []}
                selectedDate={selectedDate}
                onSelectDate={setSelectedDate}
                loading={summary.isPending}
            />

            {summary.data && summary.data.byReason.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                    {summary.data.byReason.map((entry) => (
                        <ReasonChip
                            key={entry.reason}
                            label={formatLedgerReason(entry.reason).label}
                            count={entry.count}
                            active={selectedReasons.has(entry.reason)}
                            onToggle={() => toggleReason(entry.reason)}
                        />
                    ))}
                </div>
            ) : null}

            {ledger.isPending ? (
                <div className="space-y-3">
                    {[0, 1, 2].map((i) => (
                        <div key={i} className="h-16 animate-pulse rounded-2xl bg-white/5" />
                    ))}
                </div>
            ) : ledger.isError ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-sm">
                    <p className="break-words text-destructive/90">
                        {ledger.error instanceof Error ? ledger.error.message : "Failed to load activity."}
                    </p>
                </div>
            ) : filteredRows.length === 0 ? (
                <div className="flex items-start gap-3 rounded-2xl border border-dashed border-primary/25 p-5">
                    <Gem className="mt-0.5 size-5 shrink-0 text-primary" />
                    <p className="text-sm text-muted-foreground">
                        Nothing yet — generate a summary or ask a question and it shows up here.
                    </p>
                </div>
            ) : (
                <div className="space-y-3">
                    {filteredRows.map((row) => (
                        <LedgerRow key={row.id} row={row} />
                    ))}
                    {ledger.hasNextPage ? (
                        <div ref={sentinelRef} className="flex justify-center py-3">
                            <Loader2 className="size-4 animate-spin text-muted-foreground" />
                        </div>
                    ) : null}
                </div>
            )}
        </div>
    );
}

function ReasonChip({
    label,
    count,
    active,
    onToggle,
}: {
    label: string;
    count?: number;
    active?: boolean;
    onToggle?: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onToggle}
            disabled={!onToggle}
            className={`inline-flex h-6 items-center rounded-full border px-2 font-mono text-[12px] transition-colors ${
                active ? "border-primary/40 bg-primary/10 text-primary" : "border-white/8 text-muted-foreground"
            } ${onToggle ? "hover:text-foreground" : ""}`}
        >
            {label}
            {count != null ? <span className="ml-1 opacity-70">· {count}</span> : null}
        </button>
    );
}

function LedgerRow({ row }: { row: LedgerRowData }) {
    const [expanded, setExpanded] = useState(false);
    const spend = row.delta < 0;
    const copy = formatLedgerReason(row.reason);

    return (
        <div className="rounded-2xl border border-white/8 bg-black/20 p-3">
            <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground/95">{copy.label}</p>
                    {row.context ? (
                        <button
                            type="button"
                            onClick={() => setExpanded((value) => !value)}
                            className={`mt-0.5 block w-full text-left text-sm text-muted-foreground hover:text-foreground ${
                                expanded ? "" : "truncate"
                            }`}
                        >
                            {row.context}
                        </button>
                    ) : copy.detail ? (
                        <p className="mt-0.5 text-sm text-muted-foreground">{copy.detail}</p>
                    ) : null}
                </div>
                <div className="shrink-0 text-right">
                    <p className={`text-sm font-semibold tabular-nums ${spend ? "text-foreground" : "text-primary"}`}>
                        {spend ? "−" : "+"}
                        {Math.abs(row.delta).toLocaleString("en-US").replace(",", " ")} 💎
                    </p>
                    <p className="mt-0.5 font-mono text-[12px] text-muted-foreground">
                        {formatRelativeTime(row.createdAt)}
                    </p>
                </div>
            </div>
        </div>
    );
}
