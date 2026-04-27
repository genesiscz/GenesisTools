import { toast } from "sonner";
import { Button } from "@app/utils/ui/components/button";
import { Progress } from "@app/utils/ui/components/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@app/utils/ui/components/table";
import { EmptyState } from "@app/yt/components/shared/empty-state";
import { JobStatusBadge } from "@app/yt/components/jobs/job-status-badge";
import { formatDateTime, formatDuration } from "@app/yt/lib/format";
import { useCancelJob } from "@app/yt/api.hooks";
import type { PipelineJob } from "@app/youtube/lib/types";
import { Ban, PlayCircle } from "lucide-react";

export function JobsTable({ jobs }: { jobs: PipelineJob[] }) {
    const cancelJob = useCancelJob();

    async function onCancel(id: number) {
        await cancelJob.mutateAsync(id);
        toast.success(`Job #${id} cancelled`);
    }

    if (jobs.length === 0) {
        return <EmptyState title="No jobs in the queue" body="Start a channel sync or pipeline run to see live progress here." />;
    }

    return (
        <div className="yt-panel overflow-hidden rounded-3xl">
            <Table>
                <TableHeader>
                    <TableRow className="border-primary/20 hover:bg-transparent">
                        <TableHead>Status</TableHead>
                        <TableHead>Job</TableHead>
                        <TableHead>Target</TableHead>
                        <TableHead>Stages</TableHead>
                        <TableHead>Progress</TableHead>
                        <TableHead>Duration</TableHead>
                        <TableHead>Error</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {jobs.map((job) => (
                        <TableRow key={job.id} className="border-primary/10 hover:bg-primary/5">
                            <TableCell><JobStatusBadge status={job.status} /></TableCell>
                            <TableCell className="font-mono text-primary">#{job.id}</TableCell>
                            <TableCell>
                                <div className="max-w-72 truncate font-medium">{job.target}</div>
                                <div className="font-mono text-xs text-muted-foreground">{job.targetKind}</div>
                            </TableCell>
                            <TableCell>
                                <div className="flex max-w-64 flex-wrap gap-1">
                                    {job.stages.map((stage) => (
                                        <span key={stage} className={stage === job.currentStage ? "rounded-full border border-secondary/30 bg-secondary/10 px-2 py-0.5 font-mono text-[0.65rem] text-secondary" : "rounded-full border border-border/50 bg-black/20 px-2 py-0.5 font-mono text-[0.65rem] text-muted-foreground"}>
                                            {stage}
                                        </span>
                                    ))}
                                </div>
                            </TableCell>
                            <TableCell className="min-w-52">
                                <div className="flex items-center gap-3">
                                    <Progress value={job.progress} className="h-2 bg-black/40 [&>div]:bg-gradient-to-r [&>div]:from-primary [&>div]:to-secondary" />
                                    <span className="w-10 font-mono text-xs text-secondary">{job.progress}%</span>
                                </div>
                                {job.progressMessage ? <div className="mt-1 max-w-52 truncate text-xs text-muted-foreground">{job.progressMessage}</div> : null}
                            </TableCell>
                            <TableCell className="font-mono text-xs text-muted-foreground">{formatJobDuration(job)}</TableCell>
                            <TableCell className="max-w-72 truncate text-xs text-destructive">{job.error ?? "—"}</TableCell>
                            <TableCell className="text-right">
                                {job.status === "running" || job.status === "pending" ? (
                                    <Button variant="outline" size="sm" onClick={() => onCancel(job.id)} disabled={cancelJob.isPending}>
                                        <Ban className="mr-2 size-3.5" /> Cancel
                                    </Button>
                                ) : (
                                    <span className="inline-flex items-center justify-end gap-1 text-xs text-muted-foreground"><PlayCircle className="size-3" /> idle</span>
                                )}
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}

function formatJobDuration(job: PipelineJob): string {
    const start = new Date(job.claimedAt ?? job.createdAt).getTime();
    const end = new Date(job.completedAt ?? job.updatedAt).getTime();

    if (Number.isNaN(start) || Number.isNaN(end)) {
        return formatDateTime(job.updatedAt);
    }

    return formatDuration(Math.max(0, Math.round((end - start) / 1000)));
}
