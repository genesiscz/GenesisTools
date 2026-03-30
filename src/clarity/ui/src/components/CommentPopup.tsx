import { buildWeekComment } from "@app/clarity/lib/comment-builder";
import { SafeJSON } from "@app/utils/json";
import { useMutation } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@ui/components/alert";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Textarea } from "@ui/components/textarea";
import { AlertTriangle, CheckCircle, ChevronDown, ChevronUp, MessageSquare, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

interface WeekNoteData {
    timesheetId: number;
    periodStart: string;
    periodFinish: string;
    hasNotes?: boolean;
    numberOfNotes?: number;
    timelogEntries: Array<{
        workItemId: number;
        timeTypeDescription: string;
        comment: string | null;
        date: string;
    }>;
}

interface CommentPopupProps {
    weeks: WeekNoteData[];
    userId?: number;
}

async function postNoteApi(timesheetId: number, noteText: string, userId: number) {
    const res = await fetch("/api/post-note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: SafeJSON.stringify({ timesheetId, noteText, userId }),
    });

    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Post note failed (${res.status})`);
    }

    return res.json();
}

export function CommentPopup({ weeks, userId }: CommentPopupProps) {
    const [expanded, setExpanded] = useState(false);
    const [commentTexts, setCommentTexts] = useState<Record<number, string>>({});
    const [postedWeeks, setPostedWeeks] = useState<Set<number>>(new Set());

    const defaultTexts = useMemo(() => {
        const texts: Record<number, string> = {};

        for (const week of weeks) {
            texts[week.timesheetId] = buildWeekComment(week.timelogEntries);
        }

        return texts;
    }, [weeks]);

    useEffect(() => {
        setCommentTexts(defaultTexts);
        setPostedWeeks(new Set());
    }, [defaultTexts]);

    const postMutation = useMutation({
        mutationFn: ({ timesheetId, noteText }: { timesheetId: number; noteText: string }) => {
            if (!userId) {
                throw new Error("User ID not available");
            }

            return postNoteApi(timesheetId, noteText, userId);
        },
        onSuccess: (_, variables) => {
            setPostedWeeks((prev) => new Set([...prev, variables.timesheetId]));
        },
    });

    if (weeks.length === 0) {
        return null;
    }

    return (
        <div className="fixed bottom-4 right-4 z-50 max-w-md w-full">
            {!expanded ? (
                <button
                    type="button"
                    onClick={() => setExpanded(true)}
                    className="ml-auto flex items-center gap-2 px-4 py-2 rounded-full bg-gray-900 border border-amber-500/30 text-amber-400 font-mono text-sm hover:bg-gray-800 hover:border-amber-500/50 transition-all shadow-lg cursor-pointer"
                >
                    <MessageSquare className="w-4 h-4" />
                    Notes: {weeks.length} week{weeks.length > 1 ? "s" : ""} selected
                    <ChevronUp className="w-3.5 h-3.5" />
                </button>
            ) : (
                <Card className="border-amber-500/20 shadow-2xl max-h-[70vh] flex flex-col">
                    <CardHeader className="pb-2 flex-shrink-0">
                        <div className="flex items-center justify-between">
                            <CardTitle className="text-sm font-mono text-amber-400 flex items-center gap-2">
                                <MessageSquare className="w-4 h-4" />
                                Week Notes
                            </CardTitle>
                            <button
                                type="button"
                                onClick={() => setExpanded(false)}
                                className="text-gray-500 hover:text-gray-300 cursor-pointer"
                            >
                                <ChevronDown className="w-4 h-4" />
                            </button>
                        </div>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-4 overflow-y-auto flex-1">
                        <Alert variant="warning">
                            <AlertTriangle className="w-4 h-4" />
                            <AlertDescription className="font-mono text-[10px]">
                                Comments are additive — each post creates a new note. Clarity only shows the first note
                                per week to PM. Review in Clarity after posting.
                            </AlertDescription>
                        </Alert>

                        {weeks.map((week) => {
                            const startDate = week.periodStart.split("T")[0];
                            const isPosted = postedWeeks.has(week.timesheetId);
                            const isPending =
                                postMutation.isPending && postMutation.variables?.timesheetId === week.timesheetId;
                            const text = commentTexts[week.timesheetId] ?? "";

                            return (
                                <div key={week.timesheetId} className="flex flex-col gap-2">
                                    <div className="flex items-center gap-2">
                                        <span className="font-mono text-xs text-gray-400">{startDate}</span>
                                        <Badge variant="outline" className="font-mono text-[10px]">
                                            TS#{week.timesheetId}
                                        </Badge>
                                        {week.hasNotes && !isPosted && (
                                            <Badge
                                                variant="outline"
                                                className="text-[10px] border-amber-500/30 text-amber-400"
                                            >
                                                <AlertTriangle className="w-3 h-3 mr-1" />
                                                has note
                                            </Badge>
                                        )}
                                        {isPosted && (
                                            <Badge
                                                variant="outline"
                                                className="text-[10px] border-green-500/30 text-green-400"
                                            >
                                                <CheckCircle className="w-3 h-3 mr-1" />
                                                posted
                                            </Badge>
                                        )}
                                    </div>
                                    <Textarea
                                        value={text}
                                        onChange={(e) =>
                                            setCommentTexts((prev) => ({
                                                ...prev,
                                                [week.timesheetId]: e.target.value,
                                            }))
                                        }
                                        rows={Math.min(text.split("\n").length + 1, 10)}
                                        disabled={isPosted}
                                        className="bg-black/40 border-gray-700/50 font-mono text-xs text-gray-300 resize-y focus:border-amber-500/40"
                                    />
                                    <Button
                                        size="sm"
                                        onClick={() => {
                                            postMutation.reset();
                                            postMutation.mutate({
                                                timesheetId: week.timesheetId,
                                                noteText: text,
                                            });
                                        }}
                                        disabled={isPending || isPosted || !text.trim() || !userId}
                                        className="w-full bg-amber-500/20 border border-amber-500/40 text-amber-400 hover:bg-amber-500/30 font-mono text-xs"
                                    >
                                        {isPending ? (
                                            "Posting..."
                                        ) : isPosted ? (
                                            <>
                                                <CheckCircle className="w-3.5 h-3.5 mr-1.5" />
                                                Posted
                                            </>
                                        ) : (
                                            <>
                                                <Send className="w-3.5 h-3.5 mr-1.5" />
                                                Post Comment
                                            </>
                                        )}
                                    </Button>
                                </div>
                            );
                        })}

                        {postMutation.error && (
                            <div className="text-xs font-mono text-red-400 bg-red-500/5 px-2 py-1 rounded">
                                {postMutation.error instanceof Error
                                    ? postMutation.error.message
                                    : "Failed to post note"}
                            </div>
                        )}
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
