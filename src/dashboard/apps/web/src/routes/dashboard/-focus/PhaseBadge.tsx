import type { PomodoroPhase } from "@dashboard/shared";

const labelMap: Record<PomodoroPhase, string> = {
    work: "WORK",
    short_break: "SHORT BREAK",
    long_break: "LONG BREAK",
};

const phaseClasses: Record<PomodoroPhase, { wrap: string; dot: string; label: string }> = {
    work: {
        wrap: "bg-amber-500/10 border-amber-500/30",
        dot: "bg-amber-500 animate-pulse",
        label: "text-amber-500",
    },
    short_break: {
        wrap: "bg-emerald-400/10 border-emerald-400/30",
        dot: "bg-emerald-400",
        label: "text-emerald-400",
    },
    long_break: {
        wrap: "bg-cyan-400/10 border-cyan-400/30",
        dot: "bg-cyan-400",
        label: "text-cyan-400",
    },
};

interface PhaseBadgeProps {
    phase: PomodoroPhase;
    sessionCount: number;
    cycleLength: number;
}

export function PhaseBadge({ phase, sessionCount, cycleLength }: PhaseBadgeProps) {
    const cls = phaseClasses[phase];
    const positionInCycle = (sessionCount % cycleLength) + 1;

    return (
        <div
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border transition-colors duration-1000 ${cls.wrap}`}
        >
            <span className={`h-1.5 w-1.5 rounded-full ${cls.dot}`} />
            <span className={`text-[10px] tracking-widest uppercase font-mono font-semibold ${cls.label}`}>
                {labelMap[phase]}
            </span>
            {phase === "work" && (
                <span className="text-[10px] font-mono text-muted-foreground">
                    {positionInCycle}/{cycleLength}
                </span>
            )}
        </div>
    );
}
