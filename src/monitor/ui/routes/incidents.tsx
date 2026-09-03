import { useIncidents, useLiveStatus } from "@app/monitor/ui/api.hooks";
import { EmptyState } from "@app/monitor/ui/components/empty-state";
import { IncidentsTable } from "@app/monitor/ui/components/incidents-table";
import { ErrorPanel, Loading } from "@app/monitor/ui/components/loading";
import { PageHeader, StatPill } from "@app/monitor/ui/components/page-header";
import { createFileRoute } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";

export const Route = createFileRoute("/incidents")({
    component: IncidentsPage,
});

function IncidentsPage() {
    const [openOnly, setOpenOnly] = useState(false);
    const live = useLiveStatus();
    const all = useIncidents(false);
    const open = useIncidents(true);
    const shown = openOnly ? open : all;

    if (all.isPending || open.isPending) {
        return <Loading label="Loading incidents" cards={3} />;
    }

    if (all.isError || open.isError) {
        return <ErrorPanel title="Couldn't load incidents." />;
    }

    const openCount = open.data?.length ?? 0;
    const closedCount = (all.data?.length ?? 0) - openCount;

    return (
        <div className="space-y-6">
            <PageHeader
                eyebrow="Incident log"
                live={live}
                title="When things went sideways"
                description="An incident opens the moment a watcher leaves the operational state and closes when it comes back. Unknown results (a status page that did not answer) never open or close one."
                actions={
                    <div className="flex items-center gap-1 rounded-full border border-primary/20 bg-black/30 p-1 font-mono text-[0.7rem] uppercase tracking-[0.18em]">
                        <StatPill label="Open" value={openCount} tone={openCount > 0 ? "amber" : "emerald"} />
                        <span className="h-4 w-px bg-primary/15" />
                        <StatPill label="Resolved" value={closedCount} tone="muted" />
                    </div>
                }
            >
                <div className="flex flex-wrap gap-1.5">
                    {(
                        [
                            ["all", false],
                            ["open", true],
                        ] as const
                    ).map(([label, value]) => {
                        const active = openOnly === value;

                        return (
                            <button
                                key={label}
                                type="button"
                                onClick={() => setOpenOnly(value)}
                                className={
                                    active
                                        ? "rounded-full border border-amber-400/55 bg-amber-400/15 px-3 py-1 font-mono text-[0.7rem] uppercase tracking-[0.18em] text-amber-100 shadow-[0_0_22px_rgba(245,158,11,0.18)] transition"
                                        : "rounded-full border border-border/50 bg-black/30 px-3 py-1 font-mono text-[0.7rem] uppercase tracking-[0.18em] text-muted-foreground transition hover:border-amber-400/30 hover:text-amber-100"
                                }
                            >
                                {label}
                            </button>
                        );
                    })}
                </div>
            </PageHeader>

            {(shown.data?.length ?? 0) === 0 ? (
                <EmptyState
                    icon={ShieldCheck}
                    title={openOnly ? "No open incidents" : "No incidents yet"}
                    body={
                        openOnly
                            ? "Every enabled watcher is operational or has not reported an outage."
                            : "Incidents appear here once a watcher goes degraded or down."
                    }
                />
            ) : (
                <IncidentsTable incidents={shown.data ?? []} />
            )}
        </div>
    );
}
