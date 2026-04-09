import { cn } from "@ui/lib/utils";
import { getScoreGaugeDisplay } from "./shared";

interface ScoreGaugeProps {
    score: number;
    max?: number;
    label?: string;
    className?: string;
}

export function ScoreGauge({ score, max = 100, label, className }: ScoreGaugeProps) {
    const { safeMax, clampedScore, angle } = getScoreGaugeDisplay({ score, max });

    return (
        <div className={cn("flex flex-col items-center gap-3", className)}>
            <div
                className="flex size-28 items-center justify-center rounded-full border border-white/10 bg-slate-950/80"
                style={{
                    backgroundImage: `conic-gradient(rgb(245 158 11) 0deg ${angle}deg, rgba(255,255,255,0.08) ${angle}deg 360deg)`,
                }}
            >
                <div className="flex size-20 flex-col items-center justify-center rounded-full bg-slate-950 text-center">
                    <div className="text-2xl font-mono font-semibold text-white">{clampedScore}</div>
                    <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-slate-500">/{safeMax}</div>
                </div>
            </div>
            {label ? <div className="text-xs font-mono uppercase tracking-[0.2em] text-slate-400">{label}</div> : null}
        </div>
    );
}
