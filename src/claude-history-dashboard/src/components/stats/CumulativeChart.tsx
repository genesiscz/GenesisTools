import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp } from "lucide-react";

interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	cacheCreateTokens: number;
	cacheReadTokens: number;
}

interface CumulativeChartProps {
	dailyActivity: Record<string, number>;
	dailyTokens?: Record<string, TokenUsage>;
	title?: string;
}

function formatNumber(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
	return n.toString();
}

export function CumulativeChart({ dailyActivity, dailyTokens, title = "Cumulative Growth" }: CumulativeChartProps) {
	// Transform to cumulative data
	const sortedDates = Object.entries(dailyActivity).sort(([a], [b]) => a.localeCompare(b));

	const cumulativeData = sortedDates.reduce(
		(acc, [date, count]) => {
			const prevMessages = acc.length > 0 ? acc[acc.length - 1].cumulativeMessages : 0;
			const prevTokens = acc.length > 0 ? acc[acc.length - 1].cumulativeTokens : 0;

			const dayTokens = dailyTokens?.[date];
			const totalDayTokens = dayTokens
				? dayTokens.inputTokens +
					dayTokens.outputTokens +
					dayTokens.cacheCreateTokens +
					dayTokens.cacheReadTokens
				: 0;

			acc.push({
				date,
				messages: count,
				tokens: totalDayTokens,
				cumulativeMessages: prevMessages + count,
				cumulativeTokens: prevTokens + totalDayTokens,
			});
			return acc;
		},
		[] as Array<{
			date: string;
			messages: number;
			tokens: number;
			cumulativeMessages: number;
			cumulativeTokens: number;
		}>
	);

	// Take last 30 days for display
	const displayData = cumulativeData.slice(-30);

	if (displayData.length === 0) {
		return (
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<TrendingUp className="w-5 h-5 text-cyan-500" />
						{title}
					</CardTitle>
				</CardHeader>
				<CardContent>
					<p className="text-sm text-muted-foreground">No activity data available</p>
				</CardContent>
			</Card>
		);
	}

	const maxMessages = Math.max(...displayData.map((d) => d.cumulativeMessages));
	const maxTokens = Math.max(...displayData.map((d) => d.cumulativeTokens));

	const totalMessages = displayData[displayData.length - 1]?.cumulativeMessages || 0;
	const totalTokens = displayData[displayData.length - 1]?.cumulativeTokens || 0;

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<TrendingUp className="w-5 h-5 text-cyan-500" />
					{title}
				</CardTitle>
			</CardHeader>
			<CardContent>
				{/* Summary stats */}
				<div className="flex gap-6 mb-4 text-sm">
					<div>
						<span className="text-muted-foreground">Total Messages: </span>
						<span className="font-bold text-cyan-500">{formatNumber(totalMessages)}</span>
					</div>
					{maxTokens > 0 && (
						<div>
							<span className="text-muted-foreground">Total Tokens: </span>
							<span className="font-bold text-amber-500">{formatNumber(totalTokens)}</span>
						</div>
					)}
				</div>

				{/* Chart */}
				<div className="relative h-32">
					{/* Messages area */}
					<svg
						viewBox={`0 0 ${displayData.length * 10} 100`}
						className="w-full h-full"
						preserveAspectRatio="none"
					>
						{/* Messages gradient fill */}
						<defs>
							<linearGradient id="messagesGradient" x1="0" y1="0" x2="0" y2="1">
								<stop offset="0%" stopColor="rgb(0, 240, 255)" stopOpacity="0.4" />
								<stop offset="100%" stopColor="rgb(0, 240, 255)" stopOpacity="0.05" />
							</linearGradient>
							<linearGradient id="tokensGradient" x1="0" y1="0" x2="0" y2="1">
								<stop offset="0%" stopColor="rgb(255, 149, 0)" stopOpacity="0.3" />
								<stop offset="100%" stopColor="rgb(255, 149, 0)" stopOpacity="0.05" />
							</linearGradient>
						</defs>

						{/* Tokens area (background) */}
						{maxTokens > 0 && (
							<path
								d={`
                  M 0 100
                  ${displayData
						.map((d, i) => {
							const x = i * 10;
							const y = 100 - (d.cumulativeTokens / maxTokens) * 95;
							return `L ${x} ${y}`;
						})
						.join(" ")}
                  L ${(displayData.length - 1) * 10} 100
                  Z
                `}
								fill="url(#tokensGradient)"
							/>
						)}

						{/* Messages area */}
						<path
							d={`
                M 0 100
                ${displayData
					.map((d, i) => {
						const x = i * 10;
						const y = 100 - (d.cumulativeMessages / maxMessages) * 95;
						return `L ${x} ${y}`;
					})
					.join(" ")}
                L ${(displayData.length - 1) * 10} 100
                Z
              `}
							fill="url(#messagesGradient)"
						/>

						{/* Messages line */}
						<path
							d={displayData
								.map((d, i) => {
									const x = i * 10;
									const y = 100 - (d.cumulativeMessages / maxMessages) * 95;
									return `${i === 0 ? "M" : "L"} ${x} ${y}`;
								})
								.join(" ")}
							fill="none"
							stroke="rgb(0, 240, 255)"
							strokeWidth="1.5"
						/>

						{/* Tokens line */}
						{maxTokens > 0 && (
							<path
								d={displayData
									.map((d, i) => {
										const x = i * 10;
										const y = 100 - (d.cumulativeTokens / maxTokens) * 95;
										return `${i === 0 ? "M" : "L"} ${x} ${y}`;
									})
									.join(" ")}
								fill="none"
								stroke="rgb(255, 149, 0)"
								strokeWidth="1.5"
								strokeDasharray="4 2"
							/>
						)}
					</svg>
				</div>

				{/* Date labels */}
				<div className="flex justify-between text-[10px] text-muted-foreground mt-2">
					<span>{displayData[0]?.date.slice(5)}</span>
					<span>{displayData[displayData.length - 1]?.date.slice(5)}</span>
				</div>

				{/* Legend */}
				<div className="flex gap-4 mt-3 text-xs">
					<div className="flex items-center gap-1.5">
						<div className="w-3 h-0.5 bg-cyan-500 rounded" />
						<span className="text-muted-foreground">Messages</span>
					</div>
					{maxTokens > 0 && (
						<div className="flex items-center gap-1.5">
							<div className="w-3 h-0.5 bg-amber-500 rounded border-dashed" />
							<span className="text-muted-foreground">Tokens</span>
						</div>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
