import { Badge } from "@ui/components/badge";
import { Calendar, FolderOpen, GitBranch } from "lucide-react";

import type { SessionHeaderProps } from "../types";

function formatDate(date: Date): string {
    return date.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

export function SessionHeader({ sessionInfo }: SessionHeaderProps) {
    return (
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 rounded-lg border border-border bg-muted/20 text-sm">
            {sessionInfo.title && <span className="font-semibold text-foreground mr-auto">{sessionInfo.title}</span>}

            {sessionInfo.branch && (
                <Badge variant="outline" className="gap-1 text-xs">
                    <GitBranch className="w-3 h-3" />
                    {sessionInfo.branch}
                </Badge>
            )}

            {sessionInfo.project && (
                <Badge variant="outline" className="gap-1 text-xs">
                    <FolderOpen className="w-3 h-3" />
                    {sessionInfo.project}
                </Badge>
            )}

            {sessionInfo.startedAt && (
                <Badge variant="outline" className="gap-1 text-xs" suppressHydrationWarning>
                    <Calendar className="w-3 h-3" />
                    {formatDate(sessionInfo.startedAt)}
                </Badge>
            )}

            {sessionInfo.isSubagent && (
                <Badge variant="secondary" className="text-xs">
                    Subagent
                </Badge>
            )}
        </div>
    );
}
