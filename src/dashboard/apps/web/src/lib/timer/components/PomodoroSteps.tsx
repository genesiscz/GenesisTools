import type { PomodoroSettings } from "@dashboard/shared";
import { Coffee, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

interface PomodoroStepsProps {
    settings: PomodoroSettings;
    currentPhase: "work" | "short_break" | "long_break" | undefined;
    sessionCount: number;
    /** Progress through current phase (0-1) */
    progress?: number;
    className?: string;
}

const DEFAULT_SETTINGS: PomodoroSettings = {
    workDuration: 25 * 60 * 1000,
    shortBreakDuration: 5 * 60 * 1000,
    longBreakDuration: 15 * 60 * 1000,
    sessionsBeforeLongBreak: 4,
};

function formatMinutes(ms: number): string {
    const minutes = Math.round(ms / 60000);
    return `${minutes}m`;
}

/**
 * Shows the Pomodoro cycle steps with current position highlighted
 * and progress fill on the active step
 */
export function PomodoroSteps({
    settings = DEFAULT_SETTINGS,
    currentPhase,
    sessionCount,
    progress = 0,
    className,
}: PomodoroStepsProps) {
    const config = { ...DEFAULT_SETTINGS, ...settings };
    const totalSessions = config.sessionsBeforeLongBreak;

    // Build the steps array
    // Pattern: work -> break -> work -> break -> ... -> work -> long break
    const steps: Array<{
        type: "work" | "short_break" | "long_break";
        label: string;
        duration: string;
    }> = [];

    for (let i = 0; i < totalSessions; i++) {
        steps.push({
            type: "work",
            label: "Focus",
            duration: formatMinutes(config.workDuration),
        });

        if (i < totalSessions - 1) {
            steps.push({
                type: "short_break",
                label: "Break",
                duration: formatMinutes(config.shortBreakDuration),
            });
        } else {
            steps.push({
                type: "long_break",
                label: "Long Break",
                duration: formatMinutes(config.longBreakDuration),
            });
        }
    }

    // Calculate current step index
    // sessionCount is the number of completed work sessions
    // If we're in work phase, current step = sessionCount * 2
    // If we're in break phase, current step = sessionCount * 2 - 1
    let currentStepIndex = -1;
    if (currentPhase === "work") {
        currentStepIndex = Math.min(sessionCount * 2, steps.length - 1);
    } else if (currentPhase === "short_break") {
        currentStepIndex = Math.min(sessionCount * 2 - 1, steps.length - 1);
    } else if (currentPhase === "long_break") {
        currentStepIndex = steps.length - 1;
    }

    return (
        <div className={cn("space-y-1", className)}>
            <div className="flex items-center gap-1 overflow-x-auto pb-1">
                {steps.map((step, index) => {
                    const isCompleted = index < currentStepIndex;
                    const isCurrent = index === currentStepIndex;
                    const isWork = step.type === "work";
                    const isLongBreak = step.type === "long_break";

                    // Calculate fill percentage for current step
                    const fillPercent = isCurrent ? Math.min(progress * 100, 100) : 0;

                    // Determine fill color based on step type
                    const fillColor = isWork ? "emerald" : "amber";
                    const textActiveClass = isWork ? "text-emerald-400" : "text-amber-400";

                    return (
                        <div
                            key={index}
                            className={cn(
                                "relative flex items-center gap-1 px-2 py-1 rounded-md text-xs whitespace-nowrap overflow-hidden",
                                "transition-all duration-200",
                                // Base background for all states
                                "bg-gray-800/50",
                                // Current step - ring highlight
                                isCurrent && isWork && "ring-1 ring-emerald-500/50",
                                isCurrent && !isWork && "ring-1 ring-amber-500/50",
                                // Text colors
                                (isCompleted || isCurrent) && textActiveClass,
                                !isCompleted && !isCurrent && "text-gray-500"
                            )}
                        >
                            {/* Progress fill bar - full for completed, partial for current */}
                            {(isCompleted || (isCurrent && fillPercent > 0)) && (
                                <div
                                    className="absolute inset-0 transition-all duration-300 ease-out"
                                    style={{
                                        width: isCompleted ? "100%" : `${fillPercent}%`,
                                        background: isCompleted
                                            ? fillColor === "emerald"
                                                ? "rgba(16, 185, 129, 0.3)"
                                                : "rgba(245, 158, 11, 0.3)"
                                            : fillColor === "emerald"
                                              ? "linear-gradient(90deg, rgba(16, 185, 129, 0.3) 0%, rgba(16, 185, 129, 0.3) 85%, rgba(16, 185, 129, 0) 100%)"
                                              : "linear-gradient(90deg, rgba(245, 158, 11, 0.3) 0%, rgba(245, 158, 11, 0.3) 85%, rgba(245, 158, 11, 0) 100%)",
                                    }}
                                />
                            )}

                            {/* Content */}
                            <div className="relative flex items-center gap-1">
                                {isWork ? <Zap className="h-3 w-3" /> : <Coffee className="h-3 w-3" />}
                                <span className="font-medium">{step.duration}</span>
                                {isLongBreak && <span className="text-[10px] opacity-70">long</span>}
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Current status text */}
            {currentPhase && (
                <div className="text-[10px] text-gray-500 text-center">
                    {currentPhase === "work" && `Focus session ${sessionCount + 1} of ${totalSessions}`}
                    {currentPhase === "short_break" && `Break ${sessionCount} of ${totalSessions - 1}`}
                    {currentPhase === "long_break" && "Long break - cycle complete!"}
                </div>
            )}
        </div>
    );
}
