import { Badge } from "@ui/components/badge";
import { cn } from "@ui/lib/utils";
import type { PropertyCardModel } from "./property-card-model";
import { GRADE_COLORS } from "./watchlist-utils";

export function PropertyVerdictMini({ grade, model }: { grade: string | null; model: PropertyCardModel }) {
    const gradeStyle = grade ? (GRADE_COLORS[grade] ?? "") : "";

    return (
        <div className="rounded-md border border-white/5 bg-black/20 px-3 py-3">
            <div className="text-[10px] font-mono uppercase tracking-wider text-gray-600">Verdict</div>
            <div className="mt-2 flex items-center gap-2">
                <Badge variant="outline" className={cn("text-[10px] font-mono", gradeStyle)}>
                    {grade ?? "-"}
                </Badge>
                <span className="text-xs font-mono text-gray-300">{model.recommendation ?? "No recommendation"}</span>
            </div>
            <div className="mt-3 space-y-2 text-[11px] font-mono text-gray-400">
                {model.reasons.length > 0 ? (
                    model.reasons.map((reason) => (
                        <div key={reason} className="flex items-start gap-2">
                            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400/70" />
                            <span>{reason}</span>
                        </div>
                    ))
                ) : (
                    <div>No stored verdict yet.</div>
                )}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] font-mono text-gray-400">
                {model.verdictChecklist.map((item) => (
                    <div key={item.label} className="flex items-center gap-2">
                        <span
                            className={cn("h-2 w-2 rounded-full", item.passed ? "bg-emerald-400/80" : "bg-rose-400/80")}
                        />
                        <span>{item.label}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
