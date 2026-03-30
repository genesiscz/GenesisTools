import { Alert, AlertDescription } from "@ui/components/alert";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { Badge } from "@ui/components/badge";
import { AlertTriangle, CheckCircle, ExternalLink } from "lucide-react";

interface ExecuteFillResult {
    success: number;
    failed: number;
    skipped: number;
    entries: Array<{
        clarityTaskName: string;
        clarityTaskCode: string;
        timesheetId: number;
        timeEntryId: number;
        totalHours: number;
        segments: Array<{ date: string; hours: number }>;
        status: "success" | "error" | "skipped";
        error?: string;
    }>;
}

interface PostFillReviewDialogProps {
    open: boolean;
    onClose: () => void;
    result: ExecuteFillResult;
    commentedWeeks?: number[];
}

export function PostFillReviewDialog({ open, onClose, result, commentedWeeks }: PostFillReviewDialogProps) {
    const successWeeks = [...new Set(result.entries.filter((e) => e.status === "success").map((e) => e.timesheetId))];
    const hasComments = commentedWeeks && commentedWeeks.length > 0;

    return (
        <AlertDialog open={open} onOpenChange={(v) => !v && onClose()}>
            <AlertDialogContent className="bg-gray-950 border-amber-500/30">
                <AlertDialogHeader>
                    <AlertDialogTitle className="font-mono text-amber-400 flex items-center gap-2">
                        <AlertTriangle className="w-5 h-5" />
                        Review Required
                    </AlertDialogTitle>
                    <AlertDialogDescription className="text-gray-400 font-mono text-xs">
                        Fill operation completed. Manual review is mandatory.
                    </AlertDialogDescription>
                </AlertDialogHeader>

                <div className="flex flex-col gap-3">
                    <Alert variant="warning">
                        <AlertTriangle className="w-4 h-4" />
                        <AlertDescription className="font-mono text-xs">
                            <ul className="list-disc ml-4 flex flex-col gap-1">
                                <li>
                                    Hours updated for{" "}
                                    <span className="text-amber-300 font-bold">{successWeeks.length} week(s)</span>.
                                </li>
                                <li>You MUST review the filled hours in Clarity PPM before submitting.</li>
                                {hasComments && (
                                    <li>
                                        Comments were posted to {commentedWeeks.length} week(s) — verify they appear
                                        correctly. Clarity only shows the first note per week to PM. Additional notes
                                        are invisible.
                                    </li>
                                )}
                                <li>Submit each week manually in Clarity after verification.</li>
                            </ul>
                        </AlertDescription>
                    </Alert>

                    <div className="flex flex-col gap-1">
                        <div className="text-[10px] font-mono text-gray-500 uppercase tracking-wider">
                            Affected Timesheets
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                            {successWeeks.map((tsId) => (
                                <Badge
                                    key={tsId}
                                    variant="outline"
                                    className="font-mono text-[10px] border-green-500/30 text-green-400"
                                >
                                    <CheckCircle className="w-3 h-3 mr-1" />
                                    TS#{tsId}
                                    {hasComments && commentedWeeks.includes(tsId) && " + note"}
                                </Badge>
                            ))}
                        </div>
                    </div>

                    {result.failed > 0 && (
                        <div className="text-xs font-mono text-red-400">
                            {result.failed} entries failed — check the results below for details.
                        </div>
                    )}
                </div>

                <AlertDialogFooter>
                    <AlertDialogAction className="bg-amber-500/20 border border-amber-500/40 text-amber-400 hover:bg-amber-500/30 font-mono text-sm">
                        <ExternalLink className="w-4 h-4 mr-2" />I understand, I will review
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
