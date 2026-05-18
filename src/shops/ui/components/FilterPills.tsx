import { Badge } from "@app/utils/ui/components/badge";
import { cn } from "@app/utils/ui/lib/utils";

export type WatchlistFilter = "all" | "alerting" | "quiet";

interface FilterPillsProps {
    value: WatchlistFilter;
    onChange: (next: WatchlistFilter) => void;
    counts: Record<WatchlistFilter, number>;
}

const OPTIONS: { value: WatchlistFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "alerting", label: "Alerting" },
    { value: "quiet", label: "Quiet" },
];

export function FilterPills({ value, onChange, counts }: FilterPillsProps) {
    return (
        <div className="flex items-center gap-1.5 font-mono text-xs">
            {OPTIONS.map((opt) => (
                <button
                    key={opt.value}
                    type="button"
                    onClick={() => onChange(opt.value)}
                    className={cn(
                        "px-2.5 py-1 rounded-full border transition-all",
                        value === opt.value
                            ? "border-cyan-400 bg-cyan-400/10 text-cyan-300"
                            : "border-border text-muted-foreground hover:text-foreground hover:border-border"
                    )}
                >
                    {opt.label}
                    <Badge
                        variant="secondary"
                        className={cn(
                            "ml-2 font-mono text-[10px]",
                            opt.value === "alerting" && counts.alerting > 0 && "bg-red-500/20 text-red-200"
                        )}
                    >
                        {counts[opt.value]}
                    </Badge>
                </button>
            ))}
        </div>
    );
}
