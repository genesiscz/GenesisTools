import type { JobStatus } from "@app/youtube/lib/types";
import { useJobs } from "@app/yt/api.hooks";
import { JobsTable } from "@app/yt/components/jobs/jobs-table";
import { Loading } from "@app/yt/components/shared/loading";
import { useEventStream } from "@app/yt/ws.client";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

const statusOptions: Array<JobStatus | "all"> = [
    "all",
    "pending",
    "running",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
];

export const Route = createFileRoute("/jobs")({
    component: JobsPage,
});

function JobsPage() {
    const [status, setStatus] = useState<JobStatus | "all">("all");
    const params = useMemo(() => ({ limit: 100, status: status === "all" ? undefined : status }), [status]);
    const allJobs = useJobs({ limit: 100 });
    const filteredJobs = useJobs(params);
    const queryClient = useQueryClient();
    const stream = useEventStream({
        onEvent: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
        onClose: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
    });

    const counts = useMemo(() => {
        const map: Record<string, number> = { all: allJobs.data?.length ?? 0 };

        for (const job of allJobs.data ?? []) {
            map[job.status] = (map[job.status] ?? 0) + 1;
        }

        return map;
    }, [allJobs.data]);

    if (filteredJobs.isPending) {
        return <Loading label="Loading pipeline jobs" />;
    }

    return (
        <div className="space-y-6">
            <header className="yt-panel relative overflow-hidden rounded-3xl p-6">
                <div className="pointer-events-none absolute inset-y-0 right-0 w-1/2 bg-gradient-to-l from-cyan-500/[0.07] via-transparent to-transparent" />
                <div className="relative flex flex-col gap-5">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div className="space-y-2">
                            <div className="flex items-center gap-3">
                                <span
                                    className={
                                        stream.connected
                                            ? "size-2 rounded-full bg-emerald-400 shadow-[0_0_14px_rgba(16,185,129,0.85)]"
                                            : "size-2 rounded-full bg-amber-400/70"
                                    }
                                />
                                <p className="font-mono text-[0.7rem] uppercase tracking-[0.32em] text-secondary">
                                    {stream.connected ? "Pipeline monitor · live" : "Pipeline monitor · reconnecting"}
                                </p>
                            </div>
                            <h1 className="bg-gradient-to-r from-amber-200 via-amber-300 to-cyan-300 bg-clip-text text-3xl font-bold tracking-tight text-transparent sm:text-4xl">
                                Jobs inspector
                            </h1>
                            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                                Watch discovery, transcript, download, and summarization stages move through the local
                                queue in real time. Click any row to see every LLM, embedding, and transcription call
                                recorded against that job.
                            </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1 rounded-full border border-primary/20 bg-black/30 p-1 font-mono text-[0.7rem] uppercase tracking-[0.18em]">
                            <StatPill label="Total" value={counts.all ?? 0} tone="amber" />
                            <span className="h-4 w-px bg-primary/15" />
                            <StatPill label="Running" value={counts.running ?? 0} tone="cyan" />
                            <StatPill label="Failed" value={counts.failed ?? 0} tone="red" />
                        </div>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                        {statusOptions.map((option) => {
                            const active = status === option;
                            const count = counts[option] ?? 0;

                            return (
                                <button
                                    key={option}
                                    type="button"
                                    onClick={() => setStatus(option)}
                                    className={
                                        active
                                            ? "rounded-full border border-amber-400/55 bg-amber-400/15 px-3 py-1 font-mono text-[0.7rem] uppercase tracking-[0.18em] text-amber-100 shadow-[0_0_22px_rgba(245,158,11,0.18)] transition"
                                            : "rounded-full border border-border/50 bg-black/30 px-3 py-1 font-mono text-[0.7rem] uppercase tracking-[0.18em] text-muted-foreground transition hover:border-amber-400/30 hover:text-amber-100"
                                    }
                                >
                                    {option}
                                    <span
                                        className={active ? "ml-2 text-amber-200/80" : "ml-2 text-muted-foreground/60"}
                                    >
                                        {count}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            </header>
            <JobsTable jobs={filteredJobs.data ?? []} />
        </div>
    );
}

function StatPill({ label, value, tone }: { label: string; value: number; tone: "amber" | "cyan" | "red" }) {
    const valueColor = tone === "amber" ? "text-amber-200" : tone === "cyan" ? "text-cyan-200" : "text-red-300";

    return (
        <span className="flex items-center gap-2 px-2.5 py-1">
            <span className="text-muted-foreground">{label}</span>
            <span className={`font-bold ${valueColor}`}>{value}</span>
        </span>
    );
}
