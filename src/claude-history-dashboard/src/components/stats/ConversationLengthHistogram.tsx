import { BarChart3 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface ConversationLengthHistogramProps {
	conversationLengths: number[];
}

// Define buckets for the histogram
const BUCKETS = [
	{ label: "1-10", min: 1, max: 10 },
	{ label: "11-25", min: 11, max: 25 },
	{ label: "26-50", min: 26, max: 50 },
	{ label: "51-100", min: 51, max: 100 },
	{ label: "101-250", min: 101, max: 250 },
	{ label: "250+", min: 251, max: Infinity },
];

export function ConversationLengthHistogram({ conversationLengths }: ConversationLengthHistogramProps) {
	if (conversationLengths.length === 0) {
		return (
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<BarChart3 className="w-5 h-5 text-purple-500" />
						Conversation Length Distribution
					</CardTitle>
				</CardHeader>
				<CardContent>
					<p className="text-sm text-muted-foreground">No conversation data available</p>
				</CardContent>
			</Card>
		);
	}

	// Calculate bucket counts
	const bucketCounts = BUCKETS.map((bucket) => ({
		...bucket,
		count: conversationLengths.filter((len) => len >= bucket.min && len <= bucket.max).length,
	}));

	const maxCount = Math.max(...bucketCounts.map((b) => b.count), 1);
	const total = conversationLengths.length;

	// Calculate statistics
	const sorted = [...conversationLengths].sort((a, b) => a - b);
	const median =
		sorted.length % 2 === 0
			? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
			: sorted[Math.floor(sorted.length / 2)];
	const avg = conversationLengths.reduce((sum, len) => sum + len, 0) / conversationLengths.length;

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<BarChart3 className="w-5 h-5 text-purple-500" />
					Conversation Length Distribution
				</CardTitle>
			</CardHeader>
			<CardContent>
				{/* Stats summary */}
				<div className="flex gap-4 mb-4 text-sm">
					<div>
						<span className="text-muted-foreground">Avg: </span>
						<span className="font-semibold text-foreground">{Math.round(avg)} msgs</span>
					</div>
					<div>
						<span className="text-muted-foreground">Median: </span>
						<span className="font-semibold text-foreground">{Math.round(median)} msgs</span>
					</div>
					<div>
						<span className="text-muted-foreground">Total: </span>
						<span className="font-semibold text-foreground">{total}</span>
					</div>
				</div>

				{/* Histogram bars */}
				<div className="flex items-end gap-2 h-24 mb-2">
					{bucketCounts.map((bucket, index) => {
						const height = (bucket.count / maxCount) * 100;
						const percentage = total > 0 ? (bucket.count / total) * 100 : 0;

						return (
							<div key={bucket.label} className="flex-1 flex flex-col items-center justify-end h-full group">
								{/* Bar */}
								<div
									className={`w-full rounded-t transition-all duration-300 cursor-pointer hover:brightness-110 ${
										index === 0
											? "bg-purple-400"
											: index === 1
												? "bg-purple-500"
												: index === 2
													? "bg-purple-600"
													: index === 3
														? "bg-purple-700"
														: index === 4
															? "bg-purple-800"
															: "bg-purple-900"
									}`}
									style={{ height: `${Math.max(height, bucket.count > 0 ? 4 : 0)}%` }}
									title={`${bucket.label}: ${bucket.count} (${percentage.toFixed(1)}%)`}
								/>
							</div>
						);
					})}
				</div>

				{/* X-axis labels */}
				<div className="flex gap-2">
					{bucketCounts.map((bucket) => (
						<div key={bucket.label} className="flex-1 text-center">
							<span className="text-[10px] text-muted-foreground">{bucket.label}</span>
						</div>
					))}
				</div>

				{/* Count labels */}
				<div className="flex gap-2 mt-1">
					{bucketCounts.map((bucket) => (
						<div key={bucket.label} className="flex-1 text-center">
							<span className="text-[10px] font-mono text-foreground">{bucket.count}</span>
						</div>
					))}
				</div>
			</CardContent>
		</Card>
	);
}
