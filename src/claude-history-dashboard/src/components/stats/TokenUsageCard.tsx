import { ArrowDown, ArrowUp, Coins, Database, Zap } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	cacheCreateTokens: number;
	cacheReadTokens: number;
}

interface TokenUsageCardProps {
	tokenUsage: TokenUsage;
}

// Token pricing per 1M tokens (approximate)
const TOKEN_PRICES = {
	opus: { input: 15, output: 75, cacheCreate: 18.75, cacheRead: 1.5 },
	sonnet: { input: 3, output: 15, cacheCreate: 3.75, cacheRead: 0.3 },
	haiku: { input: 0.8, output: 4, cacheCreate: 1, cacheRead: 0.08 },
};

function formatTokens(n: number): string {
	if (n >= 1_000_000_000) {
		return `${(n / 1_000_000_000).toFixed(1)}B`;
	}
	if (n >= 1_000_000) {
		return `${(n / 1_000_000).toFixed(1)}M`;
	}
	if (n >= 1_000) {
		return `${(n / 1_000).toFixed(1)}K`;
	}
	return n.toString();
}

function estimateCost(tokenUsage: TokenUsage, modelPrices = TOKEN_PRICES.opus): number {
	const cost =
		(tokenUsage.inputTokens / 1_000_000) * modelPrices.input +
		(tokenUsage.outputTokens / 1_000_000) * modelPrices.output +
		(tokenUsage.cacheCreateTokens / 1_000_000) * modelPrices.cacheCreate +
		(tokenUsage.cacheReadTokens / 1_000_000) * modelPrices.cacheRead;
	return cost;
}

export function TokenUsageCard({ tokenUsage }: TokenUsageCardProps) {
	const totalTokens =
		tokenUsage.inputTokens + tokenUsage.outputTokens + tokenUsage.cacheCreateTokens + tokenUsage.cacheReadTokens;
	const estimatedCost = estimateCost(tokenUsage);

	// Calculate percentages for the breakdown bar
	const inputPercent = totalTokens > 0 ? (tokenUsage.inputTokens / totalTokens) * 100 : 0;
	const outputPercent = totalTokens > 0 ? (tokenUsage.outputTokens / totalTokens) * 100 : 0;
	const cacheCreatePercent = totalTokens > 0 ? (tokenUsage.cacheCreateTokens / totalTokens) * 100 : 0;
	const cacheReadPercent = totalTokens > 0 ? (tokenUsage.cacheReadTokens / totalTokens) * 100 : 0;

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Coins className="w-5 h-5 text-amber-500" />
					Token Usage
				</CardTitle>
			</CardHeader>
			<CardContent>
				{/* Total & Cost */}
				<div className="flex items-baseline gap-3 mb-4">
					<span className="text-3xl font-bold text-foreground">{formatTokens(totalTokens)}</span>
					<span className="text-sm text-muted-foreground">tokens</span>
					<span className="ml-auto text-xl font-semibold text-amber-500">~${estimatedCost.toFixed(2)}</span>
				</div>

				{/* Breakdown Bar */}
				<div className="flex h-3 rounded-full overflow-hidden mb-4 bg-muted/30">
					<div
						className="bg-cyan-500 transition-all"
						style={{ width: `${inputPercent}%` }}
						title={`Input: ${formatTokens(tokenUsage.inputTokens)}`}
					/>
					<div
						className="bg-amber-500 transition-all"
						style={{ width: `${outputPercent}%` }}
						title={`Output: ${formatTokens(tokenUsage.outputTokens)}`}
					/>
					<div
						className="bg-purple-500 transition-all"
						style={{ width: `${cacheCreatePercent}%` }}
						title={`Cache Create: ${formatTokens(tokenUsage.cacheCreateTokens)}`}
					/>
					<div
						className="bg-green-500 transition-all"
						style={{ width: `${cacheReadPercent}%` }}
						title={`Cache Read: ${formatTokens(tokenUsage.cacheReadTokens)}`}
					/>
				</div>

				{/* Legend */}
				<div className="grid grid-cols-2 gap-2 text-xs">
					<div className="flex items-center gap-2">
						<ArrowDown className="w-3 h-3 text-cyan-500" />
						<span className="text-muted-foreground">Input</span>
						<span className="ml-auto font-mono text-foreground">{formatTokens(tokenUsage.inputTokens)}</span>
					</div>
					<div className="flex items-center gap-2">
						<ArrowUp className="w-3 h-3 text-amber-500" />
						<span className="text-muted-foreground">Output</span>
						<span className="ml-auto font-mono text-foreground">{formatTokens(tokenUsage.outputTokens)}</span>
					</div>
					<div className="flex items-center gap-2">
						<Database className="w-3 h-3 text-purple-500" />
						<span className="text-muted-foreground">Cache Create</span>
						<span className="ml-auto font-mono text-foreground">{formatTokens(tokenUsage.cacheCreateTokens)}</span>
					</div>
					<div className="flex items-center gap-2">
						<Zap className="w-3 h-3 text-green-500" />
						<span className="text-muted-foreground">Cache Read</span>
						<span className="ml-auto font-mono text-foreground">{formatTokens(tokenUsage.cacheReadTokens)}</span>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
