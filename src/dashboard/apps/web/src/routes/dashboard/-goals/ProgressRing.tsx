import { cn } from "@ui/lib/utils";

interface ProgressRingProps {
    /** 0-100 */
    value: number;
    size?: number;
    strokeWidth?: number;
    className?: string;
    /** Tailwind text-color class driving the arc (stroke="currentColor"). */
    colorClassName?: string;
    "data-testid"?: string;
}

export function ProgressRing({
    value,
    size = 72,
    strokeWidth = 7,
    className,
    colorClassName = "text-primary",
    "data-testid": testId,
}: ProgressRingProps) {
    const clamped = Math.max(0, Math.min(100, value));
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (clamped / 100) * circumference;

    return (
        <div
            className={cn("relative inline-flex items-center justify-center", className)}
            style={{ width: size, height: size }}
            data-testid={testId}
            data-progress={clamped}
        >
            <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
                <circle
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    fill="none"
                    strokeWidth={strokeWidth}
                    className="text-border"
                    stroke="currentColor"
                    opacity={0.35}
                />
                <circle
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    fill="none"
                    strokeWidth={strokeWidth}
                    strokeLinecap="round"
                    className={cn(colorClassName, "transition-[stroke-dashoffset] duration-500 ease-out")}
                    stroke="currentColor"
                    strokeDasharray={circumference}
                    strokeDashoffset={offset}
                    style={{ filter: "drop-shadow(0 0 4px currentColor)" }}
                />
            </svg>
            <span className="absolute inset-0 flex items-center justify-center">
                <span className={cn("font-mono font-semibold tabular-nums", size >= 64 ? "text-sm" : "text-xs")}>
                    {clamped}%
                </span>
            </span>
        </div>
    );
}
