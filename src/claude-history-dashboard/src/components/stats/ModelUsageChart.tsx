import { Bot } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface ModelUsageChartProps {
	modelCounts: Record<string, number>;
}

const MODEL_COLORS: Record<string, { bg: string; text: string; label: string }> = {
	opus: { bg: "bg-amber-500", text: "text-amber-500", label: "Opus 4" },
	sonnet: { bg: "bg-cyan-500", text: "text-cyan-500", label: "Sonnet 4" },
	haiku: { bg: "bg-green-500", text: "text-green-500", label: "Haiku 4" },
	other: { bg: "bg-gray-500", text: "text-gray-500", label: "Other" },
};

export function ModelUsageChart({ modelCounts }: ModelUsageChartProps) {
	const total = Object.values(modelCounts).reduce((sum, count) => sum + count, 0);

	if (total === 0) {
		return (
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<Bot className="w-5 h-5 text-cyan-500" />
						Model Usage
					</CardTitle>
				</CardHeader>
				<CardContent>
					<p className="text-sm text-muted-foreground">No model usage data available</p>
				</CardContent>
			</Card>
		);
	}

	// Sort models by count
	const sortedModels = Object.entries(modelCounts)
		.filter(([, count]) => count > 0)
		.sort(([, a], [, b]) => b - a);

	// Calculate cumulative offset for pie chart segments
	let cumulativePercent = 0;

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Bot className="w-5 h-5 text-cyan-500" />
					Model Usage
				</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="flex items-center gap-6">
					{/* Donut Chart */}
					<div className="relative w-28 h-28 shrink-0">
						<svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
							<title>Model usage chart</title>
							{sortedModels.map(([model, count]) => {
								const percent = (count / total) * 100;
								const startPercent = cumulativePercent;
								cumulativePercent += percent;
								const { bg } = MODEL_COLORS[model] || MODEL_COLORS.other;

								// Convert to stroke-dasharray format
								const circumference = 100;
								const dashArray = `${percent} ${circumference - percent}`;
								const dashOffset = -startPercent;

								return (
									<circle
										key={model}
										cx="18"
										cy="18"
										r="15.91549430918954"
										fill="transparent"
										className={bg.replace("bg-", "stroke-")}
										strokeWidth="4"
										strokeDasharray={dashArray}
										strokeDashoffset={dashOffset}
										strokeLinecap="round"
									/>
								);
							})}
						</svg>
						{/* Center text */}
						<div className="absolute inset-0 flex flex-col items-center justify-center">
							<span className="text-xl font-bold text-foreground">{total.toLocaleString()}</span>
							<span className="text-[10px] text-muted-foreground">calls</span>
						</div>
					</div>

					{/* Legend */}
					<div className="flex-1 space-y-2">
						{sortedModels.map(([model, count]) => {
							const percent = (count / total) * 100;
							const { bg, label } = MODEL_COLORS[model] || MODEL_COLORS.other;

							return (
								<div key={model} className="flex items-center gap-2">
									<div className={`w-3 h-3 rounded-sm ${bg}`} />
									<span className="text-sm text-foreground flex-1">{label}</span>
									<span className="text-xs text-muted-foreground">{count.toLocaleString()}</span>
									<span className="text-xs font-mono text-foreground w-12 text-right">{percent.toFixed(1)}%</span>
								</div>
							);
						})}
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
