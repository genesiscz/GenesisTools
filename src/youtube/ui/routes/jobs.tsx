import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@app/utils/ui/components/select";
import { JobsTable } from "@app/yt/components/jobs/jobs-table";
import { Loading } from "@app/yt/components/shared/loading";
import { useJobs } from "@app/yt/api.hooks";
import { useEventStream } from "@app/yt/ws.client";
import type { JobStatus } from "@app/youtube/lib/types";

const statusOptions: Array<JobStatus | "all"> = ["all", "pending", "running", "completed", "failed", "cancelled", "interrupted"];

export const Route = createFileRoute("/jobs")({
    component: JobsPage,
});

function JobsPage() {
    const [status, setStatus] = useState<JobStatus | "all">("all");
    const params = useMemo(() => ({ limit: 100, status: status === "all" ? undefined : status }), [status]);
    const jobs = useJobs(params);
    const queryClient = useQueryClient();

    useEventStream({
        onEvent: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
        onClose: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
    });

    if (jobs.isPending) {
        return <Loading label="Loading pipeline jobs" />;
    }

    return (
        <div className="space-y-6">
            <header className="yt-panel rounded-3xl p-5">
                <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
                    <div>
                        <p className="font-mono text-xs uppercase tracking-[0.3em] text-secondary">Pipeline monitor</p>
                        <h1 className="mt-2 text-3xl font-bold">Jobs inspector</h1>
                        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                            Watch discovery, transcript, download, and summarization stages move through the local queue in real time.
                        </p>
                    </div>
                    <label className="w-full space-y-2 md:w-56">
                        <span className="font-mono text-xs uppercase tracking-[0.22em] text-muted-foreground">Status</span>
                        <Select value={status} onValueChange={(value) => setStatus(value as JobStatus | "all")}>
                            <SelectTrigger className="bg-black/30">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {statusOptions.map((option) => (
                                    <SelectItem key={option} value={option}>{option}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </label>
                </div>
            </header>
            <JobsTable jobs={jobs.data ?? []} />
        </div>
    );
}
