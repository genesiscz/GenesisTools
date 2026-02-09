import { GitBranch } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface BranchActivityChartProps {
	branchCounts: Record<string, number>;
}

export function BranchActivityChart({ branchCounts }: BranchActivityChartProps) {
	// Sort branches by count and take top 10
	const sortedBranches = Object.entries(branchCounts)
		.sort(([, a], [, b]) => b - a)
		.slice(0, 10);

	const maxCount = sortedBranches[0]?.[1] || 1;

	if (sortedBranches.length === 0) {
		return (
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<GitBranch className="w-5 h-5 text-green-500" />
						Git Branch Activity
					</CardTitle>
				</CardHeader>
				<CardContent>
					<p className="text-sm text-muted-foreground">No branch data available</p>
				</CardContent>
			</Card>
		);
	}

	// Function to truncate long branch names
	const truncateBranch = (name: string, maxLen = 25) => {
		if (name.length <= maxLen) return name;
		// Keep the last part after the last slash
		const parts = name.split("/");
		if (parts.length > 1) {
			const lastPart = parts[parts.length - 1];
			if (lastPart.length <= maxLen - 3) {
				return "..." + lastPart;
			}
		}
		return name.slice(0, maxLen - 3) + "...";
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<GitBranch className="w-5 h-5 text-green-500" />
					Git Branch Activity
				</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="space-y-2.5">
					{sortedBranches.map(([branch, count], index) => {
						const percentage = (count / maxCount) * 100;
						const isMain = branch === "main" || branch === "master";

						return (
							<div key={branch} className="group">
								<div className="flex items-center justify-between mb-1">
									<span
										className={`text-xs truncate max-w-[180px] ${isMain ? "text-green-400 font-medium" : "text-foreground"}`}
										title={branch}
									>
										{truncateBranch(branch)}
									</span>
									<span className="text-xs text-muted-foreground font-mono">
										{count.toLocaleString()}
									</span>
								</div>
								<div className="h-1.5 bg-muted/30 rounded-full overflow-hidden">
									<div
										className={`h-full rounded-full transition-all duration-300 ${
											isMain ? "bg-green-500" : index < 3 ? "bg-cyan-500" : "bg-cyan-500/60"
										}`}
										style={{ width: `${percentage}%` }}
									/>
								</div>
							</div>
						);
					})}
				</div>

				{Object.keys(branchCounts).length > 10 && (
					<p className="text-xs text-muted-foreground mt-4 text-center">
						Showing top 10 of {Object.keys(branchCounts).length} branches
					</p>
				)}
			</CardContent>
		</Card>
	);
}
