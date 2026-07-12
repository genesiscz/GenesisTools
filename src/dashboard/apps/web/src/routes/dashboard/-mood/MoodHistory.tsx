import { Badge } from "@ui/components/badge";
import { Card } from "@ui/components/card";
import { ScrollArea } from "@ui/components/scroll-area";
import { cn } from "@ui/lib/utils";
import { Trash2 } from "lucide-react";
import type { MoodEntryRow } from "@/lib/mood/mood.server";
import { ENERGY_COLOR, ENERGY_LABELS, formatDayShort, type MoodValue, moodMeta } from "@/lib/mood/mood-scale";

interface MoodHistoryProps {
    entries: MoodEntryRow[];
    today: string;
    onDelete: (day: string) => void;
}

export function MoodHistory({ entries, today, onDelete }: MoodHistoryProps) {
    return (
        <Card variant="wow-static" data-testid="mood-history" className="rounded-2xl p-5 gap-0">
            <div className="mb-4 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-foreground">History</h3>
                <span className="font-mono text-[10px] tracking-widest uppercase text-muted-foreground/50">
                    {entries.length} {entries.length === 1 ? "entry" : "entries"}
                </span>
            </div>

            {entries.length === 0 ? (
                <div
                    data-testid="mood-history-empty"
                    className="flex flex-col items-center justify-center gap-2 py-10 text-center"
                >
                    <span className="text-3xl opacity-60">🗓️</span>
                    <p className="text-sm font-medium text-foreground">No check-ins yet</p>
                    <p className="text-xs text-muted-foreground">Your daily reflections will appear here.</p>
                </div>
            ) : (
                <ScrollArea className="h-[440px] pr-3">
                    <ul className="flex flex-col gap-2">
                        {entries.map((entry) => (
                            <MoodHistoryItem
                                key={entry.id}
                                entry={entry}
                                isToday={entry.day === today}
                                onDelete={onDelete}
                            />
                        ))}
                    </ul>
                </ScrollArea>
            )}
        </Card>
    );
}

interface MoodHistoryItemProps {
    entry: MoodEntryRow;
    isToday: boolean;
    onDelete: (day: string) => void;
}

function MoodHistoryItem({ entry, isToday, onDelete }: MoodHistoryItemProps) {
    const meta = moodMeta(entry.mood);
    const energyLabel = ENERGY_LABELS[entry.energy as MoodValue] ?? "Steady";

    return (
        <li
            data-testid="mood-history-item"
            className="group flex items-start gap-3 rounded-xl border border-border bg-background/40 p-3 transition-colors hover:bg-muted/30"
        >
            <span
                className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-xl"
                style={{ backgroundColor: `${meta.color}1f` }}
            >
                {meta.emoji}
            </span>

            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{formatDayShort(entry.day)}</span>
                    {isToday && (
                        <Badge variant="cyber-secondary" className="px-1.5 py-0 text-[10px]">
                            Today
                        </Badge>
                    )}
                    <span className={cn("text-xs font-medium", meta.textClass)}>{meta.label}</span>
                    <span className="text-xs text-muted-foreground">·</span>
                    <span className="text-xs" style={{ color: ENERGY_COLOR }}>
                        {energyLabel}
                    </span>
                </div>

                {entry.note && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{entry.note}</p>}

                {entry.tags.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                        {entry.tags.map((tag) => (
                            <span
                                key={tag}
                                className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
                            >
                                #{tag}
                            </span>
                        ))}
                    </div>
                )}
            </div>

            <button
                type="button"
                aria-label="Delete entry"
                onClick={() => onDelete(entry.day)}
                className="shrink-0 rounded-md p-1.5 text-muted-foreground/50 opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
            >
                <Trash2 className="h-3.5 w-3.5" />
            </button>
        </li>
    );
}
