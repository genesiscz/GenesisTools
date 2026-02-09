import { useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

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
	return date.toISOString().split("T")[0];
}

function getDateRange(days: number | null): { from: string; to: string } {
	const to = new Date();
	const from = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : new Date(0);
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
			<div className="flex items-center gap-1 p-1 glass-card rounded-lg border border-amber-500/20">
				{presets.map(({ label, days }) => (
					<button
						key={label}
						type="button"
						className={cn(
							"h-7 px-3 text-xs font-mono rounded transition-all",
							activePreset === days
								? "bg-amber-500/20 text-amber-400 neon-glow"
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
					onChange={(e) => handleCustomChange("from", e.target.value)}
					className="h-7 w-32 text-xs px-2"
				/>
				<span className="text-cyan-400">→</span>
				<Input
					type="date"
					value={value.to}
					onChange={(e) => handleCustomChange("to", e.target.value)}
					className="h-7 w-32 text-xs px-2"
				/>
			</div>
		</div>
	);
}
