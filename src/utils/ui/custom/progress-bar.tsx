import { useEffect, useState } from "react";

interface ProgressBarProps {
    value: number;
    max?: number;
    label?: string;
    showPercentage?: boolean;
    /** Optional CSS gradient. Defaults to violet → purple. */
    color?: string;
}

export function ProgressBar({
    value,
    max = 100,
    label,
    showPercentage = false,
    color = "linear-gradient(90deg, #7c3aed, #8b5cf6)",
}: ProgressBarProps) {
    const [width, setWidth] = useState(0);
    const pct = Math.min(100, Math.max(0, (value / max) * 100));

    useEffect(() => {
        const timer = setTimeout(() => setWidth(pct), 100);
        return () => clearTimeout(timer);
    }, [pct]);

    return (
        <div className="w-full">
            {(label || showPercentage) && (
                <div className="flex items-center justify-between mb-1.5">
                    {label && <span className="text-xs text-muted-foreground">{label}</span>}
                    {showPercentage && <span className="text-xs text-muted-foreground/70">{Math.round(pct)}%</span>}
                </div>
            )}
            <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${width}%`, background: color }} />
            </div>
        </div>
    );
}
