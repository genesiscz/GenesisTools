import { Link } from "@tanstack/react-router";
import { ArrowRight, Brain, Coffee, X, Zap } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { EnergyHeatmapData } from "@/lib/assistant/lib/storage/types";
import type { Task } from "@/lib/assistant/types";
import { cn } from "@/lib/utils";

interface FocusRecommendationProps {
    heatmapData: EnergyHeatmapData | null;
    tasks: Task[];
    className?: string;
}

/**
 * Determine if current time is in peak focus window
 */
function isInPeakWindow(heatmapData: EnergyHeatmapData | null): boolean {
    if (!heatmapData?.peakTime) {
        return false;
    }

    const now = new Date();
    const currentHour = now.getHours();

    // Check if within 2 hours of peak time on similar days
    const peakHour = heatmapData.peakTime.hour;
    const hourDiff = Math.abs(currentHour - peakHour);

    // Also check if this day/hour combo has good historical data
    const hourlyAvg = heatmapData.hourlyAverages[currentHour] ?? 0;

    return hourDiff <= 2 && hourlyAvg >= 3.5;
}

/**
 * Determine if current time is in low energy window
 */
function isInLowWindow(heatmapData: EnergyHeatmapData | null): boolean {
    if (!heatmapData?.lowTime) {
        return false;
    }

    const now = new Date();
    const currentHour = now.getHours();

    const lowHour = heatmapData.lowTime.hour;
    const hourDiff = Math.abs(currentHour - lowHour);

    return hourDiff <= 1;
}

/**
 * Get the most suitable task based on current energy window
 */
function getRecommendedTask(tasks: Task[], isHighEnergy: boolean): Task | null {
    const activeTasks = tasks.filter((t) => t.status !== "completed");

    if (activeTasks.length === 0) {
        return null;
    }

    if (isHighEnergy) {
        // During peak focus: prioritize critical/important tasks
        const criticalTask = activeTasks.find((t) => t.urgencyLevel === "critical");
        if (criticalTask) {
            return criticalTask;
        }

        const importantTask = activeTasks.find((t) => t.urgencyLevel === "important");
        if (importantTask) {
            return importantTask;
        }
    } else {
        // During low energy: prioritize nice-to-have or admin tasks
        const easyTask = activeTasks.find((t) => t.urgencyLevel === "nice-to-have");
        if (easyTask) {
            return easyTask;
        }
    }

    // Default to first active task
    return activeTasks[0];
}

/**
 * Format current time for display
 */
function formatCurrentTime(): string {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();

    const hour12 = hours % 12 || 12;
    const ampm = hours < 12 ? "am" : "pm";
    const paddedMinutes = minutes.toString().padStart(2, "0");

    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const dayName = dayNames[now.getDay()];

    return `${dayName} ${hour12}:${paddedMinutes}${ampm}`;
}

/**
 * FocusRecommendation - Time-based task suggestion banner
 *
 * Shows contextual recommendations based on current time vs
 * the user's historical energy patterns.
 */
export function FocusRecommendation({ heatmapData, tasks, className }: FocusRecommendationProps) {
    const [dismissed, setDismissed] = useState(false);

    if (dismissed) {
        return null;
    }

    const isPeakTime = isInPeakWindow(heatmapData);
    const isLowTime = isInLowWindow(heatmapData);
    const recommendedTask = getRecommendedTask(tasks, isPeakTime);

    // Don't show if no clear recommendation
    if (!heatmapData || (!isPeakTime && !isLowTime)) {
        return null;
    }

    const currentTime = formatCurrentTime();

    return (
        <div
            className={cn(
                "relative rounded-lg border p-4",
                "overflow-hidden",
                isPeakTime ? "bg-amber-500/10 border-amber-500/30" : "bg-cyan-500/10 border-cyan-500/30",
                className
            )}
        >
            {/* Animated glow background for peak time */}
            {isPeakTime && (
                <div
                    className="absolute inset-0 opacity-20"
                    style={{
                        background: "radial-gradient(circle at 20% 50%, rgba(251, 191, 36, 0.3) 0%, transparent 50%)",
                        animation: "pulse 2s ease-in-out infinite",
                    }}
                />
            )}

            <div className="relative flex items-start gap-4">
                {/* Icon */}
                <div
                    className={cn(
                        "flex-shrink-0 p-3 rounded-lg",
                        isPeakTime ? "bg-amber-500/20 text-amber-400" : "bg-cyan-500/20 text-cyan-400"
                    )}
                >
                    {isPeakTime ? <Zap className="h-6 w-6" /> : <Coffee className="h-6 w-6" />}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                        <span
                            className={cn(
                                "text-xs font-mono uppercase tracking-wider",
                                isPeakTime ? "text-amber-400" : "text-cyan-400"
                            )}
                        >
                            {currentTime}
                        </span>
                        <span
                            className={cn(
                                "px-2 py-0.5 rounded text-xs font-semibold",
                                isPeakTime ? "bg-amber-500/20 text-amber-300" : "bg-cyan-500/20 text-cyan-300"
                            )}
                        >
                            {isPeakTime ? "Peak Focus Time" : "Recovery Period"}
                        </span>
                    </div>

                    <p className="text-slate-200 font-medium mb-2">
                        {isPeakTime
                            ? "This is your peak productivity window. Tackle something challenging!"
                            : "Energy typically dips around now. Consider lighter tasks or a break."}
                    </p>

                    {recommendedTask && (
                        <div className="flex items-center gap-3">
                            <span className="text-sm text-slate-400">Suggested:</span>
                            <Link
                                to="/assistant/tasks/$taskId"
                                params={{ taskId: recommendedTask.id }}
                                className={cn(
                                    "inline-flex items-center gap-2 px-3 py-1.5 rounded-md",
                                    "text-sm font-medium transition-colors",
                                    isPeakTime
                                        ? "bg-amber-500/20 text-amber-200 hover:bg-amber-500/30"
                                        : "bg-cyan-500/20 text-cyan-200 hover:bg-cyan-500/30"
                                )}
                            >
                                <Brain className="h-4 w-4" />
                                <span className="truncate max-w-[200px]">{recommendedTask.title}</span>
                                <ArrowRight className="h-4 w-4" />
                            </Link>
                        </div>
                    )}
                </div>

                {/* Dismiss button */}
                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setDismissed(true)}
                    className="flex-shrink-0 text-slate-500 hover:text-slate-300"
                >
                    <X className="h-4 w-4" />
                    <span className="sr-only">Dismiss</span>
                </Button>
            </div>
        </div>
    );
}

/**
 * Compact version of focus recommendation for sidebar/widget use
 */
export function FocusRecommendationCompact({ heatmapData, className }: Omit<FocusRecommendationProps, "tasks">) {
    const isPeakTime = isInPeakWindow(heatmapData);
    const isLowTime = isInLowWindow(heatmapData);

    if (!heatmapData || (!isPeakTime && !isLowTime)) {
        return null;
    }

    return (
        <div
            className={cn(
                "flex items-center gap-2 px-3 py-2 rounded-lg text-sm",
                isPeakTime
                    ? "bg-amber-500/10 border border-amber-500/20 text-amber-300"
                    : "bg-cyan-500/10 border border-cyan-500/20 text-cyan-300",
                className
            )}
        >
            {isPeakTime ? (
                <>
                    <Zap className="h-4 w-4 text-amber-400" />
                    <span>Peak focus time - tackle complex work!</span>
                </>
            ) : (
                <>
                    <Coffee className="h-4 w-4 text-cyan-400" />
                    <span>Low energy period - take it easy</span>
                </>
            )}
        </div>
    );
}
