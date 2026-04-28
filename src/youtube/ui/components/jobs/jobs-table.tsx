import { formatDuration } from "@app/utils/format";
import { Button } from "@app/utils/ui/components/button";
import { Progress } from "@app/utils/ui/components/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@app/utils/ui/components/table";
import type { PipelineJob } from "@app/youtube/lib/types";
import { useCancelJob } from "@app/yt/api.hooks";
import { JobActivityDrawer } from "@app/yt/components/jobs/job-activity-drawer";
import { JobStatusBadge } from "@app/yt/components/jobs/job-status-badge";
import { EmptyState } from "@app/yt/components/shared/empty-state";
import { formatDateTime, parseSqliteDate } from "@app/yt/lib/format";
import { Activity, Ban, ChevronRight, PlayCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export function JobsTable({ jobs }: { jobs: PipelineJob[] }) {
    const cancelJob = useCancelJob();
    const [activityJobId, setActivityJobId] = useState<number | null>(null);

    async function onCancel(event: React.MouseEvent, id: number) {
        event.stopPropagation();
        await cancelJob.mutateAsync(id);
        toast.success(`Job #${id} cancelled`);
    }

    if (jobs.length === 0) {
        return (
            <EmptyState
                title="No jobs match this filter"
                body="Pipeline runs you start (or channel syncs you trigger) will appear here in real time."
            />
        );
    }

    return (
        <>
            <div className="yt-panel overflow-hidden rounded-3xl">
                <Table>
                    <TableHeader>
                        <TableRow className="border-primary/20 hover:bg-transparent">
                            <TableHead className="font-mono text-[0.65rem] uppercase tracking-[0.22em] text-muted-foreground">
                                Status
                            </TableHead>
                            <TableHead className="font-mono text-[0.65rem] uppercase tracking-[0.22em] text-muted-foreground">
                                Job
                            </TableHead>
                            <TableHead className="font-mono text-[0.65rem] uppercase tracking-[0.22em] text-muted-foreground">
                                Target
                            </TableHead>
                            <TableHead className="font-mono text-[0.65rem] uppercase tracking-[0.22em] text-muted-foreground">
                                Stages
                            </TableHead>
                            <TableHead className="font-mono text-[0.65rem] uppercase tracking-[0.22em] text-muted-foreground">
                                Progress
                            </TableHead>
                            <TableHead className="font-mono text-[0.65rem] uppercase tracking-[0.22em] text-muted-foreground">
                                Duration
                            </TableHead>
                            <TableHead className="font-mono text-[0.65rem] uppercase tracking-[0.22em] text-muted-foreground">
                                Error
                            </TableHead>
                            <TableHead className="text-right font-mono text-[0.65rem] uppercase tracking-[0.22em] text-muted-foreground">
                                Actions
                            </TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {jobs.map((job) => {
                            const isActive = job.status === "running" || job.status === "pending";
                            const isFailed = job.status === "failed";

                            return (
                                <TableRow
                                    key={job.id}
                                    className="group cursor-pointer border-primary/10 transition-all duration-200 hover:bg-primary/[0.06] hover:shadow-[inset_3px_0_0_rgb(245_158_11_/_70%)]"
                                    onClick={() => setActivityJobId(job.id)}
                                >
                                    <TableCell>
                                        <JobStatusBadge status={job.status} />
                                    </TableCell>
                                    <TableCell>
                                        <span className="font-mono text-sm font-semibold text-primary">#{job.id}</span>
                                    </TableCell>
                                    <TableCell>
                                        <div className="max-w-72 truncate font-medium text-foreground/95">
                                            {job.target}
                                        </div>
                                        <div className="mt-0.5 font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground">
                                            {job.targetKind}
                                        </div>
                                    </TableCell>
                                    <TableCell>
                                        <div className="flex max-w-64 flex-wrap gap-1">
                                            {job.stages.map((stage) => {
                                                const current = stage === job.currentStage;

                                                return (
                                                    <span
                                                        key={stage}
                                                        className={
                                                            current
                                                                ? "rounded-full border border-cyan-400/45 bg-cyan-400/10 px-2 py-0.5 font-mono text-[0.65rem] uppercase tracking-[0.16em] text-cyan-200 shadow-[0_0_14px_rgba(34,211,238,0.25)]"
                                                                : "rounded-full border border-border/40 bg-black/30 px-2 py-0.5 font-mono text-[0.65rem] uppercase tracking-[0.16em] text-muted-foreground"
                                                        }
                                                    >
                                                        {stage}
                                                    </span>
                                                );
                                            })}
                                        </div>
                                    </TableCell>
                                    <TableCell className="min-w-52">
                                        <div className="flex items-center gap-3">
                                            <Progress
                                                value={Math.round((job.progress ?? 0) * 100)}
                                                className={
                                                    isFailed
                                                        ? "h-2 bg-black/40 [&>div]:bg-gradient-to-r [&>div]:from-red-500 [&>div]:to-red-300"
                                                        : "h-2 bg-black/40 [&>div]:bg-gradient-to-r [&>div]:from-amber-400 [&>div]:to-cyan-300"
                                                }
                                            />
                                            <span className="w-10 font-mono text-xs font-semibold text-cyan-200">
                                                {Math.round((job.progress ?? 0) * 100)}%
                                            </span>
                                        </div>
                                        {job.progressMessage ? (
                                            <div className="mt-1 max-w-52 truncate font-mono text-[0.7rem] text-muted-foreground">
                                                {job.progressMessage}
                                            </div>
                                        ) : null}
                                    </TableCell>
                                    <TableCell className="font-mono text-xs text-muted-foreground">
                                        {formatJobDuration(job)}
                                    </TableCell>
                                    <TableCell className="max-w-72 truncate font-mono text-xs text-red-300/90">
                                        {job.error ?? "—"}
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <div className="flex items-center justify-end gap-2">
                                            <button
                                                type="button"
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    setActivityJobId(job.id);
                                                }}
                                                className="inline-flex items-center gap-1.5 rounded-full border border-cyan-400/30 bg-cyan-400/[0.06] px-2.5 py-1 font-mono text-[0.65rem] uppercase tracking-[0.18em] text-cyan-200 transition hover:border-cyan-300/55 hover:bg-cyan-400/15 hover:shadow-[0_0_18px_rgba(34,211,238,0.25)]"
                                            >
                                                <Activity className="size-3" />
                                                Activity
                                                <ChevronRight className="size-3 opacity-60 transition-transform group-hover:translate-x-0.5" />
                                            </button>
                                            {isActive ? (
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={(event) => onCancel(event, job.id)}
                                                    disabled={cancelJob.isPending}
                                                    className="h-7 gap-1.5 border-red-400/30 bg-red-500/5 px-2.5 font-mono text-[0.65rem] uppercase tracking-[0.18em] text-red-200 hover:border-red-300/55 hover:bg-red-500/15 hover:text-red-100"
                                                >
                                                    <Ban className="size-3" />
                                                    Cancel
                                                </Button>
                                            ) : (
                                                <span className="inline-flex items-center justify-end gap-1 font-mono text-[0.65rem] uppercase tracking-[0.18em] text-muted-foreground/70">
                                                    <PlayCircle className="size-3" /> idle
                                                </span>
                                            )}
                                        </div>
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            </div>
            <JobActivityDrawer
                jobId={activityJobId}
                open={activityJobId !== null}
                onOpenChange={(open) => {
                    if (!open) {
                        setActivityJobId(null);
                    }
                }}
            />
        </>
    );
}

function formatJobDuration(job: PipelineJob): string {
    const start = parseSqliteDate(job.claimedAt ?? job.createdAt)?.getTime();
    const end = parseSqliteDate(job.completedAt ?? job.updatedAt)?.getTime();

    if (start === undefined || end === undefined || Number.isNaN(start) || Number.isNaN(end)) {
        return formatDateTime(job.updatedAt);
    }

    return formatDuration(Math.max(0, end - start), "ms", "hms");
}
