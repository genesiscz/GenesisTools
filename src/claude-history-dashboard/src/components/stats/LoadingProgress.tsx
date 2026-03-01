interface LoadingProgressProps {
	loadedDays: number;
	totalDays: number;
	isLoading: boolean;
}

export function LoadingProgress({ loadedDays, totalDays, isLoading }: LoadingProgressProps) {
	if (!isLoading) {
		return null;
	}

	const percentage = totalDays > 0 ? (loadedDays / totalDays) * 100 : 0;

	return (
		<div className="flex items-center gap-3 text-xs font-mono text-muted-foreground mb-6 glass-card p-3 rounded-lg border border-amber-500/20">
			<div className="w-2 h-2 bg-cyan-500 rounded-full animate-neon-pulse" />
			<span>
				Loading historical data: {loadedDays}/{totalDays} days
			</span>
			<div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
				<div
					className="h-full bg-gradient-to-r from-amber-500 to-cyan-500 rounded-full transition-all duration-300 ease-out"
					style={{ width: `${percentage}%` }}
				/>
			</div>
			<span className="text-cyan-400">{percentage.toFixed(0)}%</span>
		</div>
	);
}
