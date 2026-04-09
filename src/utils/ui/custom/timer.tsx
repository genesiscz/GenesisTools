import { useEffect, useId, useState } from "react";

interface TimerProps {
    /** Starting seconds (counts down). Default 1500 (25 min Pomodoro). */
    initialSeconds?: number;
    label?: string;
    /** Diameter in px. Default 100. */
    size?: number;
    /** Gradient stops for the progress ring. Default red → orange. */
    gradientFrom?: string;
    gradientTo?: string;
}

export function Timer({
    initialSeconds = 1500,
    label,
    size = 100,
    gradientFrom = "#ef4444",
    gradientTo = "#f97316",
}: TimerProps) {
    const safeInit = Math.max(1, initialSeconds);
    const [seconds, setSeconds] = useState(safeInit);
    const gradientId = useId();
    const radius = (size - 8) / 2;
    const circumference = 2 * Math.PI * radius;
    const progress = ((safeInit - seconds) / safeInit) * circumference;
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;

    useEffect(() => {
        setSeconds(Math.max(1, initialSeconds));
    }, [initialSeconds]);

    useEffect(() => {
        if (seconds <= 0) {
            return;
        }

        const interval = setInterval(() => {
            setSeconds((s) => Math.max(0, s - 1));
        }, 1000);

        return () => clearInterval(interval);
    }, [seconds]);

    const formatTime = (m: number, s: number) => `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;

    return (
        <div className="flex flex-col items-center gap-2">
            <div className="relative" style={{ width: size, height: size }}>
                <svg className="timer-circle" width={size} height={size}>
                    <circle cx={size / 2} cy={size / 2} r={radius} stroke="#1e1e28" strokeWidth="4" fill="none" />
                    <circle
                        cx={size / 2}
                        cy={size / 2}
                        r={radius}
                        stroke={`url(#${gradientId})`}
                        strokeWidth="4"
                        fill="none"
                        strokeLinecap="round"
                        strokeDasharray={circumference}
                        strokeDashoffset={circumference - progress}
                        className="timer-progress"
                    />
                    <defs>
                        <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
                            <stop offset="0%" stopColor={gradientFrom} />
                            <stop offset="100%" stopColor={gradientTo} />
                        </linearGradient>
                    </defs>
                </svg>
                <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-lg font-mono font-semibold text-foreground animate-timer-pulse">
                        {formatTime(minutes, secs)}
                    </span>
                </div>
            </div>
            {label && <span className="text-xs text-muted-foreground">{label}</span>}
        </div>
    );
}
