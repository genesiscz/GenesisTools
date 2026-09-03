import type { WatcherStatus, WatcherSummary } from "@app/monitor/lib/types";
import { useLiveStatus, useOverview } from "@app/monitor/ui/api.hooks";
import { EmptyState } from "@app/monitor/ui/components/empty-state";
import { ErrorPanel, Loading } from "@app/monitor/ui/components/loading";
import { PageHeader, StatPill } from "@app/monitor/ui/components/page-header";
import { WatcherCard } from "@app/monitor/ui/components/watcher-card";
import { WatcherDialog } from "@app/monitor/ui/components/watcher-dialog";
import { Button } from "@genesiscz/utils/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";

type Filter = "all" | WatcherStatus | "paused";

const FILTERS: Filter[] = ["all", "down", "degraded", "up", "unknown", "paused"];

export const Route = createFileRoute("/")({
    component: OverviewPage,
});

const ORDER: Record<WatcherStatus, number> = { down: 0, degraded: 1, unknown: 2, up: 3 };

function sortWatchers(watchers: WatcherSummary[]): WatcherSummary[] {
    return [...watchers].sort((a, b) => {
        if (a.enabled !== b.enabled) {
            return a.enabled ? -1 : 1;
        }

        const byStatus = ORDER[a.lastStatus] - ORDER[b.lastStatus];

        return byStatus !== 0 ? byStatus : a.name.localeCompare(b.name);
    });
}

function OverviewPage() {
    const overview = useOverview();
    const live = useLiveStatus();
    const [filter, setFilter] = useState<Filter>("all");
    const [adding, setAdding] = useState(false);
    const [editing, setEditing] = useState<WatcherSummary | null>(null);
    const watchers = useMemo(() => sortWatchers(overview.data?.watchers ?? []), [overview.data?.watchers]);
    const counts = overview.data?.counts;
    const filtered = useMemo(() => {
        if (filter === "all") {
            return watchers;
        }

        if (filter === "paused") {
            return watchers.filter((watcher) => !watcher.enabled);
        }

        return watchers.filter((watcher) => watcher.enabled && watcher.lastStatus === filter);
    }, [watchers, filter]);

    if (overview.isPending) {
        return <Loading />;
    }

    if (overview.isError || !counts) {
        return <ErrorPanel title="Couldn't load watchers." />;
    }

    const filterCount = (option: Filter): number => {
        if (option === "all") {
            return counts.total;
        }

        return counts[option];
    };

    return (
        <div className="space-y-6">
            <PageHeader
                eyebrow="Watch tower"
                live={live}
                title="Everything you keep an eye on"
                description="Websites, public status pages and your own AI accounts, checked on a schedule by the monitor server. Cards glow with the last known state and update live as checks land."
                actions={
                    <div className="flex items-center gap-1 rounded-full border border-primary/20 bg-black/30 p-1 font-mono text-[0.7rem] uppercase tracking-[0.18em]">
                        <StatPill label="Up" value={counts.up} tone="emerald" />
                        <span className="h-4 w-px bg-primary/15" />
                        <StatPill label="Degraded" value={counts.degraded} tone="amber" />
                        <StatPill label="Down" value={counts.down} tone="red" />
                    </div>
                }
            >
                <div className="flex flex-wrap gap-1.5">
                    {FILTERS.map((option) => {
                        const active = filter === option;

                        return (
                            <button
                                key={option}
                                type="button"
                                onClick={() => setFilter(option)}
                                className={
                                    active
                                        ? "rounded-full border border-amber-400/55 bg-amber-400/15 px-3 py-1 font-mono text-[0.7rem] uppercase tracking-[0.18em] text-amber-100 shadow-[0_0_22px_rgba(245,158,11,0.18)] transition"
                                        : "rounded-full border border-border/50 bg-black/30 px-3 py-1 font-mono text-[0.7rem] uppercase tracking-[0.18em] text-muted-foreground transition hover:border-amber-400/30 hover:text-amber-100"
                                }
                            >
                                {option}
                                <span className={active ? "ml-2 text-amber-200/80" : "ml-2 text-muted-foreground/60"}>
                                    {filterCount(option)}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </PageHeader>

            {watchers.length === 0 ? (
                <EmptyState
                    title="Nothing is being watched yet"
                    body="Add a website, a public status page like status.claude.com, or one of your AI accounts. The first check runs the moment you save."
                    cta={
                        <Button className="btn-glow" onClick={() => setAdding(true)}>
                            <Plus className="size-4" /> Add your first watcher
                        </Button>
                    }
                />
            ) : filtered.length === 0 ? (
                <EmptyState title={`No ${filter} watchers`} body="Pick another filter, or add a watcher." />
            ) : (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {filtered.map((watcher) => (
                        <WatcherCard key={watcher.id} watcher={watcher} onEdit={setEditing} />
                    ))}
                </div>
            )}

            <WatcherDialog open={adding} onOpenChange={setAdding} />
            <WatcherDialog
                open={editing !== null}
                onOpenChange={(open) => !open && setEditing(null)}
                watcher={editing}
            />
        </div>
    );
}
