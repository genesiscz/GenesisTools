import { Input } from "@ui/components/input";
import { cn } from "@ui/lib/utils";
import { useState } from "react";

interface DateRangePickerProps {
    value: { from: string; to: string };
    onChange: (range: { from: string; to: string }) => void;
    className?: string;
}

const presets = [
    { label: "Today", days: 1 },
    { label: "7d", days: 7 },
    { label: "30d", days: 30 },
    { label: "90d", days: 90 },
    { label: "All", days: null },
] as const;

function formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function getDateRange(days: number | null): { from: string; to: string } {
    const to = new Date();

    if (days === null) {
        return { from: "1970-01-01", to: formatDate(to) };
    }

    const from = new Date(to);
    from.setDate(from.getDate() - (days - 1));
    return { from: formatDate(from), to: formatDate(to) };
}

export function DateRangePicker({ value, onChange, className }: DateRangePickerProps) {
    const [activePreset, setActivePreset] = useState<number | null>(null);

    const handlePresetClick = (days: number | null) => {
        setActivePreset(days);
        onChange(getDateRange(days));
    };

    const handleCustomChange = (field: "from" | "to", newValue: string) => {
        setActivePreset(null); // Clear preset when using custom dates
        onChange({ ...value, [field]: newValue });
    };

    return (
        <div className={cn("flex flex-col sm:flex-row items-start sm:items-center gap-4", className)}>
            {/* Preset buttons */}
            <div className="flex items-center gap-1 p-1 glass-card rounded-lg border border-primary/20">
                {presets.map(({ label, days }) => (
                    <button
                        key={label}
                        type="button"
                        className={cn(
                            "h-7 px-3 text-xs font-mono rounded transition-all",
                            activePreset === days
                                ? "bg-primary/20 text-primary neon-glow"
                                : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                        )}
                        onClick={() => handlePresetClick(days)}
                    >
                        {label}
                    </button>
                ))}
            </div>

            {/* Custom range inputs */}
            <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
                <span className="hidden sm:inline">Custom:</span>
                <Input
                    type="date"
                    value={value.from}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleCustomChange("from", e.target.value)}
                    className="h-7 w-32 text-xs px-2"
                />
                <span className="text-primary">→</span>
                <Input
                    type="date"
                    value={value.to}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleCustomChange("to", e.target.value)}
                    className="h-7 w-32 text-xs px-2"
                />
            </div>
        </div>
    );
}
