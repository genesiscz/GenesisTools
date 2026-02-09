import { Activity, Minus, TrendingDown, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	cacheCreateTokens: number;
	cacheReadTokens: number;
}

interface WeeklyTrendsCardProps {
	dailyActivity: Record<string, number>;
	dailyTokens?: Record<string, TokenUsage>;
}

function getTrendIcon(percent: number) {
	if (percent > 5) return <TrendingUp className="w-4 h-4 text-green-500" />;
	if (percent < -5) return <TrendingDown className="w-4 h-4 text-red-500" />;
	return <Minus className="w-4 h-4 text-muted-foreground" />;
}

function getTrendColor(percent: number): string {
	if (percent > 5) return "text-green-500";
	if (percent < -5) return "text-red-500";
	return "text-muted-foreground";
}

function formatNumber(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
	return n.toString();
}

// Format date to YYYY-MM-DD using local timezone
function formatDateLocal(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function calculateWeeklyStats(dailyActivity: Record<string, number>, dailyTokens?: Record<string, TokenUsage>) {
	const today = new Date();
	const thisWeekStart = new Date(today);
	thisWeekStart.setDate(today.getDate() - 6);
	const lastWeekStart = new Date(today);
	lastWeekStart.setDate(today.getDate() - 13);

	// Use string comparisons with YYYY-MM-DD format to avoid timezone issues
	const todayStr = formatDateLocal(today);
	const thisWeekStartStr = formatDateLocal(thisWeekStart);
	const lastWeekStartStr = formatDateLocal(lastWeekStart);

	let thisWeekMessages = 0;
	let lastWeekMessages = 0;
	let thisWeekTokens = 0;
	let lastWeekTokens = 0;
	let thisWeekDays = 0;
	let lastWeekDays = 0;

	for (const [dateStr, count] of Object.entries(dailyActivity)) {
		const dayTokens = dailyTokens?.[dateStr];
		const totalDayTokens = dayTokens
			? dayTokens.inputTokens + dayTokens.outputTokens + dayTokens.cacheCreateTokens + dayTokens.cacheReadTokens
			: 0;

		// Use string comparisons to avoid timezone off-by-one errors
		if (dateStr >= thisWeekStartStr && dateStr <= todayStr) {
			thisWeekMessages += count;
			thisWeekTokens += totalDayTokens;
			thisWeekDays++;
		} else if (dateStr >= lastWeekStartStr && dateStr < thisWeekStartStr) {
			lastWeekMessages += count;
			lastWeekTokens += totalDayTokens;
			lastWeekDays++;
		}
	}

	// Calculate percentage changes
	const messageChange =
		lastWeekMessages > 0
			? ((thisWeekMessages - lastWeekMessages) / lastWeekMessages) * 100
			: thisWeekMessages > 0
				? 100
				: 0;

	const tokenChange =
		lastWeekTokens > 0 ? ((thisWeekTokens - lastWeekTokens) / lastWeekTokens) * 100 : thisWeekTokens > 0 ? 100 : 0;

	// Calculate averages
	const avgMessagesThisWeek = thisWeekDays > 0 ? Math.round(thisWeekMessages / thisWeekDays) : 0;
	const avgMessagesLastWeek = lastWeekDays > 0 ? Math.round(lastWeekMessages / lastWeekDays) : 0;

	return {
		thisWeekMessages,
		lastWeekMessages,
		thisWeekTokens,
		lastWeekTokens,
		messageChange,
		tokenChange,
		avgMessagesThisWeek,
		avgMessagesLastWeek,
	};
}

export function WeeklyTrendsCard({ dailyActivity, dailyTokens }: WeeklyTrendsCardProps) {
	const stats = calculateWeeklyStats(dailyActivity, dailyTokens);

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Activity className="w-5 h-5 text-primary" />
					Weekly Trends
				</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="grid grid-cols-2 gap-4">
					{/* Messages This Week */}
					<div className="space-y-1">
						<div className="flex items-center gap-2">
							<span className="text-xs text-muted-foreground uppercase tracking-wide">Messages</span>
							{getTrendIcon(stats.messageChange)}
						</div>
						<div className="flex items-baseline gap-2">
							<span className="text-2xl font-bold text-foreground">
								{formatNumber(stats.thisWeekMessages)}
							</span>
							<span className={`text-sm font-medium ${getTrendColor(stats.messageChange)}`}>
								{stats.messageChange > 0 ? "+" : ""}
								{stats.messageChange.toFixed(0)}%
							</span>
						</div>
						<div className="text-xs text-muted-foreground">
							vs {formatNumber(stats.lastWeekMessages)} last week
						</div>
					</div>

					{/* Tokens This Week */}
					<div className="space-y-1">
						<div className="flex items-center gap-2">
							<span className="text-xs text-muted-foreground uppercase tracking-wide">Tokens</span>
							{getTrendIcon(stats.tokenChange)}
						</div>
						<div className="flex items-baseline gap-2">
							<span className="text-2xl font-bold text-foreground">
								{formatNumber(stats.thisWeekTokens)}
							</span>
							<span className={`text-sm font-medium ${getTrendColor(stats.tokenChange)}`}>
								{stats.tokenChange > 0 ? "+" : ""}
								{stats.tokenChange.toFixed(0)}%
							</span>
						</div>
						<div className="text-xs text-muted-foreground">
							vs {formatNumber(stats.lastWeekTokens)} last week
						</div>
					</div>

					{/* Daily Average */}
					<div className="col-span-2 pt-3 border-t border-border/50">
						<div className="flex justify-between text-sm">
							<span className="text-muted-foreground">Avg messages/day this week:</span>
							<span className="font-medium text-foreground">
								{stats.avgMessagesThisWeek.toLocaleString()}
							</span>
						</div>
						<div className="flex justify-between text-sm mt-1">
							<span className="text-muted-foreground">Avg messages/day last week:</span>
							<span className="font-medium text-muted-foreground">
								{stats.avgMessagesLastWeek.toLocaleString()}
							</span>
						</div>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
