import { Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface HourlyHeatmapProps {
	hourlyActivity: Record<string, number>;
}

export function HourlyHeatmap({ hourlyActivity }: HourlyHeatmapProps) {
	// Fill in missing hours with 0
	const hours = Array.from({ length: 24 }, (_, i) => ({
		hour: i,
		count: hourlyActivity[i.toString()] || 0,
	}));

	const maxCount = Math.max(...hours.map((h) => h.count), 1);

	// Helper to get intensity class based on count
	const getIntensity = (count: number): string => {
		const ratio = count / maxCount;
		if (ratio === 0) {
			return "bg-muted/30";
		}
		if (ratio < 0.25) {
			return "bg-primary/20";
		}
		if (ratio < 0.5) {
			return "bg-primary/40";
		}
		if (ratio < 0.75) {
			return "bg-primary/60";
		}
		return "bg-primary/80 neon-glow";
	};

	// Format hour label
	const formatHour = (hour: number): string => {
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
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Clock className="w-5 h-5 text-primary" />
					Peak Activity Hours
				</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="flex flex-col gap-2">
					{/* Heatmap grid */}
					<div className="grid grid-cols-12 gap-1">
						{hours.map(({ hour, count }) => (
							<div
								key={hour}
								className={`aspect-square rounded-sm ${getIntensity(count)} transition-all hover:scale-110 cursor-pointer`}
								title={`${formatHour(hour)}: ${count.toLocaleString()} messages`}
							/>
						))}
					</div>

					{/* Hour labels */}
					<div className="grid grid-cols-12 gap-1 mt-1">
						{hours.slice(0, 12).map(({ hour }) => (
							<div key={hour} className="text-[8px] text-muted-foreground text-center">
								{hour}
							</div>
						))}
					</div>
					<div className="grid grid-cols-12 gap-1">
						{hours.slice(12).map(({ hour }) => (
							<div key={hour} className="text-[8px] text-muted-foreground text-center">
								{hour}
							</div>
						))}
					</div>

					{/* Legend */}
					<div className="flex items-center justify-end gap-2 mt-2 text-xs text-muted-foreground">
						<span>Less</span>
						<div className="flex gap-0.5">
							<div className="w-3 h-3 rounded-sm bg-muted/30" />
							<div className="w-3 h-3 rounded-sm bg-primary/20" />
							<div className="w-3 h-3 rounded-sm bg-primary/40" />
							<div className="w-3 h-3 rounded-sm bg-primary/60" />
							<div className="w-3 h-3 rounded-sm bg-primary/80" />
						</div>
						<span>More</span>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
