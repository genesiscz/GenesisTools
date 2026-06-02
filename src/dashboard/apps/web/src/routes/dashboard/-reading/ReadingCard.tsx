import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { IconButton } from "@ui/components/icon-button";
import { Input } from "@ui/components/input";
import { ProgressBar, TagChip } from "@ui/custom";
import { Check, ExternalLink, Highlighter, Minus, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { ReadingStatus } from "@/lib/reading/hooks/useReading";
import type { ReadingItemRow } from "@/lib/reading/reading.server";
import { BookCover } from "./BookCover";
import { StarRatingInput } from "./StarRatingInput";

interface ReadingCardProps {
    item: ReadingItemRow;
    onSetStatus: (id: string, status: ReadingStatus) => void;
    onSetPage: (id: string, page: number) => void;
    onSetRating: (id: string, rating: number) => void;
    onOpenDetail: (item: ReadingItemRow) => void;
    onDelete: (id: string) => void;
}

const NEXT_STATUS: Record<ReadingStatus, ReadingStatus | null> = {
    to_read: "reading",
    reading: "done",
    done: null,
};

const START_LABEL: Record<ReadingStatus, string> = {
    to_read: "Start reading",
    reading: "Mark as done",
    done: "Finished",
};

export function ReadingCard({
    item,
    onSetStatus,
    onSetPage,
    onSetRating,
    onOpenDetail,
    onDelete,
}: ReadingCardProps) {
    const [pageDraft, setPageDraft] = useState(String(item.currentPage));

    const hasPages = item.totalPages > 0;
    const pct = hasPages ? Math.min(100, Math.round((item.currentPage / item.totalPages) * 100)) : 0;
    const nextStatus = NEXT_STATUS[item.status];

    function commitPage(value: number) {
        const clamped = hasPages ? Math.min(item.totalPages, Math.max(0, value)) : Math.max(0, value);
        setPageDraft(String(clamped));
        if (clamped !== item.currentPage) {
            onSetPage(item.id, clamped);
        }

        // Reaching the final page finishes the read (criterion #3) — moves the
        // card to the Done column and surfaces the rating UI.
        if (hasPages && clamped >= item.totalPages && item.status === "reading") {
            onSetStatus(item.id, "done");
        }
    }

    return (
        <Card
            variant="wow-static"
            accent="purple"
            className="group relative flex flex-col gap-3 p-4"
            data-testid="reading-card"
            data-status={item.status}
        >
            {/* Cover + heading */}
            <div className="flex gap-3">
                <button
                    type="button"
                    onClick={() => onOpenDetail(item)}
                    className="shrink-0"
                    aria-label={`Open ${item.title}`}
                >
                    <BookCover
                        title={item.title}
                        coverUrl={item.coverUrl}
                        type={item.type}
                        className="h-24 w-16 transition-transform group-hover:-translate-y-0.5"
                    />
                </button>

                <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-start justify-between gap-2">
                        <Badge variant="cyber-secondary" className="capitalize">
                            {item.type}
                        </Badge>
                        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                            {item.url && (
                                <IconButton
                                    variant="ghost"
                                    size="icon"
                                    tooltip="Open source"
                                    className="h-7 w-7 text-muted-foreground hover:text-primary"
                                    onClick={() => window.open(item.url ?? "", "_blank", "noopener,noreferrer")}
                                >
                                    <ExternalLink className="h-3.5 w-3.5" />
                                </IconButton>
                            )}
                            <IconButton
                                variant="ghost"
                                size="icon"
                                tooltip="Delete"
                                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                onClick={() => onDelete(item.id)}
                            >
                                <Trash2 className="h-3.5 w-3.5" />
                            </IconButton>
                        </div>
                    </div>

                    <button
                        type="button"
                        onClick={() => onOpenDetail(item)}
                        className="line-clamp-2 text-left text-sm font-semibold text-foreground/90 transition-colors hover:text-primary"
                    >
                        {item.title}
                    </button>
                    {item.author && <p className="truncate text-xs text-muted-foreground">{item.author}</p>}
                </div>
            </div>

            {/* Progress (reading + done with pages) */}
            {hasPages && item.status !== "to_read" && (
                <div className="space-y-1.5" data-testid="reading-progress">
                    <ProgressBar value={item.currentPage} max={item.totalPages} />
                    <div className="flex items-center justify-between">
                        <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60">
                            {item.currentPage} / {item.totalPages} · {pct}%
                        </span>
                        {item.status === "reading" && (
                            <div className="flex items-center gap-1">
                                <IconButton
                                    variant="ghost"
                                    size="icon"
                                    tooltip="Back a page"
                                    className="h-6 w-6 text-muted-foreground hover:text-primary"
                                    onClick={() => commitPage(item.currentPage - 1)}
                                >
                                    <Minus className="h-3 w-3" />
                                </IconButton>
                                <Input
                                    type="number"
                                    value={pageDraft}
                                    min={0}
                                    max={item.totalPages}
                                    onChange={(e) => setPageDraft(e.target.value)}
                                    onBlur={() => commitPage(Number.parseInt(pageDraft, 10) || 0)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                            commitPage(Number.parseInt(pageDraft, 10) || 0);
                                        }
                                    }}
                                    className="h-6 w-14 px-1 text-center text-xs"
                                    data-testid="reading-page-input"
                                />
                                <IconButton
                                    variant="ghost"
                                    size="icon"
                                    tooltip="Forward a page"
                                    className="h-6 w-6 text-muted-foreground hover:text-primary"
                                    onClick={() => commitPage(item.currentPage + 1)}
                                    data-testid="reading-page-increment"
                                >
                                    <Plus className="h-3 w-3" />
                                </IconButton>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Rating (done items) */}
            {item.status === "done" && (
                <div className="flex items-center justify-between">
                    <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60">
                        Rating
                    </span>
                    <StarRatingInput
                        rating={item.rating}
                        onRate={(r) => onSetRating(item.id, r)}
                        size="sm"
                        data-testid="reading-rating"
                    />
                </div>
            )}

            {/* Tags */}
            {item.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                    {item.tags.map((tag) => (
                        <TagChip key={tag}>{tag}</TagChip>
                    ))}
                </div>
            )}

            {/* Actions */}
            <div className="mt-auto flex items-center gap-2 pt-1">
                {nextStatus ? (
                    <Button
                        variant={item.status === "reading" ? "brand" : "outline"}
                        size="sm"
                        className="flex-1 gap-1.5"
                        onClick={() => onSetStatus(item.id, nextStatus)}
                        data-testid="reading-advance-status"
                    >
                        {item.status === "reading" && <Check className="h-3.5 w-3.5" />}
                        {START_LABEL[item.status]}
                    </Button>
                ) : (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="flex-1 text-xs text-muted-foreground"
                        onClick={() => onSetStatus(item.id, "reading")}
                    >
                        Re-read
                    </Button>
                )}
                <IconButton
                    variant="ghost"
                    size="icon"
                    tooltip="Highlights & notes"
                    className="h-8 w-8 shrink-0 text-muted-foreground hover:text-primary"
                    onClick={() => onOpenDetail(item)}
                    data-testid="reading-highlights-button"
                >
                    <Highlighter className="h-4 w-4" />
                </IconButton>
            </div>
        </Card>
    );
}
