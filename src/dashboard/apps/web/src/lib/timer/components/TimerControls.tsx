import type { TimerType } from "@dashboard/shared";
import { ExternalLink, Flag, Pause, Play, RotateCcw, Settings } from "lucide-react";
import { memo } from "react";
import { cn } from "@/lib/utils";

interface TimerControlsProps {
    isRunning: boolean;
    timerType: TimerType;
    canAddLap?: boolean;
    onToggle: () => void;
    onReset: () => void;
    onLap?: () => void;
    onPopout?: () => void;
    onSettings?: () => void;
    className?: string;
}

/**
 * Timer control buttons with cyberpunk neon styling
 */
export const TimerControls = memo(function TimerControls({
    isRunning,
    timerType,
    canAddLap = true,
    onToggle,
    onReset,
    onLap,
    onPopout,
    onSettings,
    className,
}: TimerControlsProps) {
    const showLapButton = timerType === "stopwatch" && onLap;

    return (
        <div className={cn("flex items-center justify-center gap-4 flex-wrap", className)}>
            {/* Main play/pause button - large and prominent */}
            <button
                onClick={onToggle}
                className={cn(
                    "group relative flex items-center justify-center gap-2.5",
                    "min-w-[140px] h-14 px-6 rounded-xl",
                    "font-semibold text-base uppercase tracking-wider",
                    "transition-all duration-300 ease-out",
                    "overflow-hidden",
                    isRunning
                        ? [
                              "bg-gradient-to-br from-amber-500 to-amber-600 text-black",
                              "shadow-[0_0_30px_rgba(255,149,0,0.5),inset_0_1px_0_rgba(255,255,255,0.2)]",
                              "hover:shadow-[0_0_40px_rgba(255,149,0,0.7)]",
                              "hover:scale-[1.02] active:scale-[0.98]",
                          ]
                        : [
                              "bg-gradient-to-br from-emerald-500 to-emerald-600 text-black",
                              "shadow-[0_0_30px_rgba(52,211,153,0.5),inset_0_1px_0_rgba(255,255,255,0.2)]",
                              "hover:shadow-[0_0_40px_rgba(52,211,153,0.7)]",
                              "hover:scale-[1.02] active:scale-[0.98]",
                          ]
                )}
            >
                {/* Shimmer effect */}
                <div
                    className={cn(
                        "absolute inset-0 opacity-0 group-hover:opacity-100",
                        "bg-gradient-to-r from-transparent via-white/20 to-transparent",
                        "translate-x-[-100%] group-hover:translate-x-[100%]",
                        "transition-transform duration-700 ease-out"
                    )}
                />

                {isRunning ? (
                    <>
                        <Pause className="h-5 w-5 relative z-10" />
                        <span className="relative z-10">Pause</span>
                    </>
                ) : (
                    <>
                        <Play className="h-5 w-5 relative z-10 ml-0.5" />
                        <span className="relative z-10">Start</span>
                    </>
                )}
            </button>

            {/* Lap button - only for stopwatch */}
            {showLapButton && (
                <button
                    onClick={onLap}
                    disabled={!isRunning || !canAddLap}
                    className={cn(
                        "group relative flex items-center justify-center gap-2",
                        "h-14 px-5 rounded-xl",
                        "font-medium text-sm uppercase tracking-wider",
                        "border-2 transition-all duration-300",
                        isRunning && canAddLap
                            ? [
                                  "border-cyan-500/50 text-cyan-400",
                                  "bg-cyan-500/10 hover:bg-cyan-500/20",
                                  "shadow-[0_0_20px_rgba(0,240,255,0.2)]",
                                  "hover:shadow-[0_0_30px_rgba(0,240,255,0.4)]",
                                  "hover:border-cyan-500",
                              ]
                            : ["border-gray-700 text-gray-600", "cursor-not-allowed opacity-50"]
                    )}
                >
                    <Flag className="h-4 w-4" />
                    <span>Lap</span>
                </button>
            )}

            {/* Reset button */}
            <button
                onClick={onReset}
                className={cn(
                    "group relative flex items-center justify-center",
                    "h-12 w-12 rounded-xl",
                    "border-2 border-amber-500/30 text-amber-400/70",
                    "bg-amber-500/5 hover:bg-amber-500/15",
                    "transition-all duration-300",
                    "hover:border-amber-500/60 hover:text-amber-400",
                    "hover:shadow-[0_0_20px_rgba(255,149,0,0.3)]",
                    "active:scale-95"
                )}
                title="Reset"
            >
                <RotateCcw className="h-5 w-5 transition-transform group-hover:rotate-[-45deg]" />
            </button>

            {/* Pop-out button */}
            {onPopout && (
                <button
                    onClick={onPopout}
                    className={cn(
                        "group relative flex items-center justify-center",
                        "h-12 w-12 rounded-xl",
                        "border-2 border-purple-500/30 text-purple-400/70",
                        "bg-purple-500/5 hover:bg-purple-500/15",
                        "transition-all duration-300",
                        "hover:border-purple-500/60 hover:text-purple-400",
                        "hover:shadow-[0_0_20px_rgba(168,85,247,0.3)]",
                        "active:scale-95"
                    )}
                    title="Pop out window"
                >
                    <ExternalLink className="h-5 w-5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                </button>
            )}

            {/* Settings button */}
            {onSettings && (
                <button
                    onClick={onSettings}
                    className={cn(
                        "group relative flex items-center justify-center",
                        "h-12 w-12 rounded-xl",
                        "border-2 border-gray-600/30 text-gray-500",
                        "bg-gray-500/5 hover:bg-gray-500/15",
                        "transition-all duration-300",
                        "hover:border-gray-500/60 hover:text-gray-400",
                        "active:scale-95"
                    )}
                    title="Timer settings"
                >
                    <Settings className="h-5 w-5 transition-transform group-hover:rotate-45" />
                </button>
            )}
        </div>
    );
});
