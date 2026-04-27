import { Badge } from "@app/utils/ui/components/badge";
import type { JobStatus } from "@app/youtube/lib/types";
import { CheckCircle2, Clock3, Loader2, OctagonAlert, PauseCircle, XCircle } from "lucide-react";

const statusTone: Record<JobStatus, { label: string; className: string; icon: typeof Clock3 }> = {
    pending: { label: "pending", className: "border-slate-400/30 bg-slate-400/10 text-slate-200", icon: Clock3 },
    running: { label: "running", className: "border-cyan-400/30 bg-cyan-400/10 text-cyan-200", icon: Loader2 },
    completed: { label: "completed", className: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200", icon: CheckCircle2 },
    failed: { label: "failed", className: "border-red-400/30 bg-red-400/10 text-red-200", icon: OctagonAlert },
    cancelled: { label: "cancelled", className: "border-zinc-400/30 bg-zinc-400/10 text-zinc-200", icon: XCircle },
    interrupted: { label: "interrupted", className: "border-amber-400/30 bg-amber-400/10 text-amber-200", icon: PauseCircle },
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
    const tone = statusTone[status];
    const Icon = tone.icon;

    return (
        <Badge variant="outline" className={tone.className}>
            <Icon className={status === "running" ? "size-3 animate-spin" : "size-3"} />
            {tone.label}
        </Badge>
    );
}
