import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface HeatmapCellProps {
    day: number; // 0-6 (Sunday = 0)
    hour: number; // 0-23
    focusQuality: number; // 0-5 (0 = no data)
    count: number;
    contextSwitches?: number;
    tasksCompleted?: number;
    isPeak?: boolean;
    isLow?: boolean;
    onClick?: () => void;
}

/**
 * Day names for tooltip display
 */
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Format hour to 12-hour display
 */
function formatHour(hour: number): string {
    if (hour === 0) {
        return "12am";
    }
    if (hour === 12) {
        return "12pm";
    }
    if (hour < 12) {
        return `${hour}am`;
    }
    return `${hour - 12}pm`;
}

/**
 * Get cell background color based on focus quality
 */
function getCellColor(quality: number, hasData: boolean): string {
    if (!hasData) {
        return "bg-slate-800/30";
    }

    if (quality >= 4.5) {
        return "bg-cyan-400";
    }
    if (quality >= 4) {
        return "bg-cyan-500/80";
    }
    if (quality >= 3.5) {
        return "bg-cyan-600/60";
    }
    if (quality >= 3) {
        return "bg-cyan-700/50";
    }
    if (quality >= 2.5) {
        return "bg-amber-600/40";
    }
    if (quality >= 2) {
        return "bg-amber-700/30";
    }
    if (quality >= 1.5) {
        return "bg-red-800/40";
    }
    return "bg-red-900/30";
}

/**
 * Get border styling for the cell
 */
function getCellBorder(quality: number, hasData: boolean, isPeak: boolean, isLow: boolean): string {
    if (isPeak) {
        return "border-amber-400/60 shadow-amber-400/30";
    }
    if (isLow) {
        return "border-red-500/40";
    }
    if (!hasData) {
        return "border-slate-700/20";
    }
    if (quality >= 4) {
        return "border-cyan-500/40";
    }
    return "border-cyan-800/20";
}

/**
 * HeatmapCell - Individual cell in the energy heatmap grid
 *
 * Displays focus quality with color intensity and provides detailed
 * tooltip on hover showing day, time, quality, and activity metrics.
 */
export function HeatmapCell({
    day,
    hour,
    focusQuality,
    count,
    contextSwitches = 0,
    tasksCompleted = 0,
    isPeak = false,
    isLow = false,
    onClick,
}: HeatmapCellProps) {
    const hasData = count > 0;
    const displayQuality = hasData ? focusQuality.toFixed(1) : "--";

    const cellColor = getCellColor(focusQuality, hasData);
    const cellBorder = getCellBorder(focusQuality, hasData, isPeak, isLow);

    const tooltipContent = hasData
        ? `${DAY_NAMES[day]} ${formatHour(hour)}: ${displayQuality}/5 focus, ${contextSwitches} ${contextSwitches === 1 ? "switch" : "switches"}, ${tasksCompleted} ${tasksCompleted === 1 ? "task" : "tasks"}`
        : `${DAY_NAMES[day]} ${formatHour(hour)}: No data`;

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    onClick={onClick}
                    className={cn(
                        "w-full aspect-square rounded-sm border transition-all duration-200",
                        "hover:scale-110 hover:z-10 hover:brightness-125",
                        "focus:outline-none focus:ring-2 focus:ring-cyan-500/50",
                        cellColor,
                        cellBorder,
                        // Peak hour glow effect
                        isPeak && hasData && "shadow-lg animate-pulse",
                        // Low hour indicator
                        isLow && hasData && "opacity-80",
                        // Cursor style
                        onClick ? "cursor-pointer" : "cursor-default"
                    )}
                    style={
                        isPeak && hasData
                            ? { boxShadow: "0 0 12px rgba(251, 191, 36, 0.4)" }
                            : focusQuality >= 4 && hasData
                              ? { boxShadow: "0 0 8px rgba(34, 211, 238, 0.3)" }
                              : undefined
                    }
                    aria-label={tooltipContent}
                />
            </TooltipTrigger>
            <TooltipContent side="top" className="bg-slate-900/95 border border-cyan-500/30 text-slate-100 px-3 py-2">
                <div className="flex flex-col gap-1">
                    <span className="font-semibold text-cyan-300">
                        {DAY_NAMES[day]} {formatHour(hour)}
                    </span>
                    {hasData ? (
                        <>
                            <span>
                                Focus:{" "}
                                <span
                                    className={cn(
                                        "font-bold",
                                        focusQuality >= 4
                                            ? "text-cyan-400"
                                            : focusQuality >= 3
                                              ? "text-amber-400"
                                              : "text-red-400"
                                    )}
                                >
                                    {displayQuality}/5
                                </span>
                            </span>
                            <span className="text-slate-400 text-xs">
                                {contextSwitches} context {contextSwitches === 1 ? "switch" : "switches"} |{" "}
                                {tasksCompleted} {tasksCompleted === 1 ? "task" : "tasks"}
                            </span>
                            {isPeak && <span className="text-amber-400 text-xs font-medium">Peak focus time</span>}
                            {isLow && <span className="text-red-400 text-xs font-medium">Low energy time</span>}
                        </>
                    ) : (
                        <span className="text-slate-500">No data recorded</span>
                    )}
                </div>
            </TooltipContent>
        </Tooltip>
    );
}

/**
 * EmptyCell - Placeholder for cells with no data possibility
 */
export function EmptyCell() {
    return <div className="w-full aspect-square rounded-sm bg-slate-900/20 border border-slate-800/10" />;
}
