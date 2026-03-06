import { Check, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface TimeEditorProps {
    timeMs: number;
    onSave: (newTimeMs: number) => void;
    onCancel: () => void;
    maxHours?: number;
    className?: string;
}

/**
 * Inline time editor with hours:minutes:seconds inputs
 * Arrow keys: Left/Right to move fields, Up/Down to adjust values
 */
export function TimeEditor({ timeMs, onSave, onCancel, maxHours = 99, className }: TimeEditorProps) {
    // Convert ms to h:m:s
    const totalSeconds = Math.floor(timeMs / 1000);
    const initialHours = Math.floor(totalSeconds / 3600);
    const initialMinutes = Math.floor((totalSeconds % 3600) / 60);
    const initialSeconds = totalSeconds % 60;

    const [hours, setHours] = useState(initialHours.toString().padStart(2, "0"));
    const [minutes, setMinutes] = useState(initialMinutes.toString().padStart(2, "0"));
    const [seconds, setSeconds] = useState(initialSeconds.toString().padStart(2, "0"));

    const hoursRef = useRef<HTMLInputElement>(null);
    const minutesRef = useRef<HTMLInputElement>(null);
    const secondsRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        hoursRef.current?.focus();
        hoursRef.current?.select();
    }, []);

    function handleSave() {
        const h = Math.min(parseInt(hours, 10) || 0, maxHours);
        const m = Math.min(parseInt(minutes, 10) || 0, 59);
        const s = Math.min(parseInt(seconds, 10) || 0, 59);
        const newTimeMs = (h * 3600 + m * 60 + s) * 1000;
        onSave(newTimeMs);
    }

    function adjustValue(currentValue: string, setter: (v: string) => void, max: number, delta: number) {
        const current = parseInt(currentValue, 10) || 0;
        let newValue = current + delta;
        // Wrap around
        if (newValue < 0) {
            newValue = max;
        }
        if (newValue > max) {
            newValue = 0;
        }
        setter(newValue.toString().padStart(2, "0"));
    }

    function handleKeyDown(e: React.KeyboardEvent, field: "hours" | "minutes" | "seconds") {
        if (e.key === "Enter") {
            e.preventDefault();
            handleSave();
            return;
        }

        if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
            return;
        }

        // Arrow Up - increment
        if (e.key === "ArrowUp") {
            e.preventDefault();
            if (field === "hours") {
                adjustValue(hours, setHours, maxHours, 1);
            } else if (field === "minutes") {
                adjustValue(minutes, setMinutes, 59, 1);
            } else {
                adjustValue(seconds, setSeconds, 59, 1);
            }
            return;
        }

        // Arrow Down - decrement
        if (e.key === "ArrowDown") {
            e.preventDefault();
            if (field === "hours") {
                adjustValue(hours, setHours, maxHours, -1);
            } else if (field === "minutes") {
                adjustValue(minutes, setMinutes, 59, -1);
            } else {
                adjustValue(seconds, setSeconds, 59, -1);
            }
            return;
        }

        // Arrow Right - move to next field
        if (e.key === "ArrowRight") {
            e.preventDefault();
            if (field === "hours") {
                minutesRef.current?.focus();
                minutesRef.current?.select();
            } else if (field === "minutes") {
                secondsRef.current?.focus();
                secondsRef.current?.select();
            }
            return;
        }

        // Arrow Left - move to previous field
        if (e.key === "ArrowLeft") {
            e.preventDefault();
            if (field === "seconds") {
                minutesRef.current?.focus();
                minutesRef.current?.select();
            } else if (field === "minutes") {
                hoursRef.current?.focus();
                hoursRef.current?.select();
            }
            return;
        }
    }

    function handleInputChange(
        value: string,
        setter: (v: string) => void,
        nextRef?: React.RefObject<HTMLInputElement | null>
    ) {
        // Only allow digits
        const digits = value.replace(/\D/g, "");
        if (digits.length <= 2) {
            setter(digits);
            // Auto-advance when 2 digits entered
            if (digits.length === 2 && nextRef?.current) {
                nextRef.current.focus();
                nextRef.current.select();
            }
        }
    }

    function handleBlur(value: string, setter: (v: string) => void, max: number) {
        const num = Math.min(parseInt(value, 10) || 0, max);
        setter(num.toString().padStart(2, "0"));
    }

    const inputClassName = cn(
        "w-12 h-10 text-center text-2xl font-mono font-bold",
        "bg-transparent text-amber-400",
        "border-none outline-none",
        "selection:bg-amber-500/30"
    );

    return (
        <div className={cn("flex items-center justify-center gap-2", className)}>
            <div className="flex items-center gap-1 bg-black/60 rounded-lg p-2 border border-amber-500/30">
                {/* Hours */}
                <input
                    ref={hoursRef}
                    type="text"
                    inputMode="numeric"
                    value={hours}
                    onChange={(e) => handleInputChange(e.target.value, setHours, minutesRef)}
                    onBlur={() => handleBlur(hours, setHours, maxHours)}
                    onKeyDown={(e) => handleKeyDown(e, "hours")}
                    className={inputClassName}
                    maxLength={2}
                />
                <span className="text-xl text-amber-500/60 font-mono">:</span>

                {/* Minutes */}
                <input
                    ref={minutesRef}
                    type="text"
                    inputMode="numeric"
                    value={minutes}
                    onChange={(e) => handleInputChange(e.target.value, setMinutes, secondsRef)}
                    onBlur={() => handleBlur(minutes, setMinutes, 59)}
                    onKeyDown={(e) => handleKeyDown(e, "minutes")}
                    className={inputClassName}
                    maxLength={2}
                />
                <span className="text-xl text-amber-500/60 font-mono">:</span>

                {/* Seconds */}
                <input
                    ref={secondsRef}
                    type="text"
                    inputMode="numeric"
                    value={seconds}
                    onChange={(e) => handleInputChange(e.target.value, setSeconds)}
                    onBlur={() => handleBlur(seconds, setSeconds, 59)}
                    onKeyDown={(e) => handleKeyDown(e, "seconds")}
                    className={inputClassName}
                    maxLength={2}
                />
            </div>

            {/* Action buttons */}
            <div className="flex flex-col gap-1">
                <button
                    onClick={handleSave}
                    className="p-1.5 rounded-md bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors"
                    title="Save (Enter)"
                >
                    <Check className="h-4 w-4" />
                </button>
                <button
                    onClick={onCancel}
                    className="p-1.5 rounded-md bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
                    title="Cancel (Esc)"
                >
                    <X className="h-4 w-4" />
                </button>
            </div>
        </div>
    );
}
