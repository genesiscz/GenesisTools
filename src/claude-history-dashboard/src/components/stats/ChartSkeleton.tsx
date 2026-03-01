import { TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

// Deterministic heights to avoid SSR hydration mismatch
const CHART_SKELETON_HEIGHTS = Array.from({ length: 14 }, (_, i) => 20 + ((i * 37) % 60));

export function ActivityChartSkeleton() {
	return (
		<Card className="mb-8">
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<TrendingUp className="w-5 h-5 text-primary animate-pulse-glow" />
					<Skeleton className="h-5 w-48" />
				</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="flex items-end gap-1 h-32">
					{Array.from({ length: 14 }).map((_, i) => (
						/* biome-ignore lint/suspicious/noArrayIndexKey: static skeleton list */
						<div key={i} className="flex-1 flex flex-col items-center justify-end h-full gap-1">
							<Skeleton
								variant="data-stream"
								className="w-full rounded-t"
								style={{
									height: `${CHART_SKELETON_HEIGHTS[i]}%`,
									animationDelay: `${i * 100}ms`,
								}}
							/>
							<Skeleton className="h-2 w-3" variant="default" />
						</div>
					))}
				</div>
			</CardContent>
		</Card>
	);
}
