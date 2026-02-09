import { Layers } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface ToolCategoriesChartProps {
	toolCounts: Record<string, number>;
}

// Tool category definitions
const TOOL_CATEGORIES: Record<string, { pattern: RegExp | string[]; color: string; label: string }> = {
	"File Read": {
		pattern: ["Read", "Glob", "Grep", "LSP"],
		color: "bg-cyan-500",
		label: "File Read",
	},
	"File Write": {
		pattern: ["Write", "Edit", "NotebookEdit", "MultiEdit"],
		color: "bg-amber-500",
		label: "File Write",
	},
	Shell: {
		pattern: ["Bash", "KillShell", "TaskOutput"],
		color: "bg-green-500",
		label: "Shell",
	},
	Web: {
		pattern: ["WebFetch", "WebSearch"],
		color: "bg-blue-500",
		label: "Web",
	},
	Tasks: {
		pattern: ["Task", "TodoRead", "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"],
		color: "bg-purple-500",
		label: "Tasks",
	},
	MCP: {
		pattern: /^mcp__/,
		color: "bg-pink-500",
		label: "MCP",
	},
	Other: {
		pattern: [],
		color: "bg-gray-500",
		label: "Other",
	},
};

function categorize(toolName: string): string {
	for (const [category, { pattern }] of Object.entries(TOOL_CATEGORIES)) {
		if (category === "Other") continue;
		if (Array.isArray(pattern)) {
			if (pattern.some((p) => toolName === p || toolName.startsWith(p))) {
				return category;
			}
		} else if (pattern instanceof RegExp) {
			if (pattern.test(toolName)) {
				return category;
			}
		}
	}
	return "Other";
}

export function ToolCategoriesChart({ toolCounts }: ToolCategoriesChartProps) {
	// Aggregate by category
	const categoryCounts: Record<string, number> = {};
	for (const [tool, count] of Object.entries(toolCounts)) {
		const category = categorize(tool);
		categoryCounts[category] = (categoryCounts[category] || 0) + count;
	}

	// Sort by count and calculate total
	const sortedCategories = Object.entries(categoryCounts)
		.sort(([, a], [, b]) => b - a)
		.filter(([, count]) => count > 0);

	const total = sortedCategories.reduce((sum, [, count]) => sum + count, 0);

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Layers className="w-5 h-5 text-secondary" />
					Tool Categories
				</CardTitle>
			</CardHeader>
			<CardContent>
				{/* Stacked bar */}
				<div className="flex h-8 rounded-lg overflow-hidden mb-4">
					{sortedCategories.map(([category, count]) => {
						const percentage = (count / total) * 100;
						const { color } = TOOL_CATEGORIES[category] || { color: "bg-gray-500" };
						return (
							<div
								key={category}
								className={`${color} transition-all hover:brightness-110 cursor-pointer`}
								style={{ width: `${percentage}%` }}
								title={`${category}: ${count.toLocaleString()} (${percentage.toFixed(1)}%)`}
							/>
						);
					})}
				</div>

				{/* Legend */}
				<div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
					{sortedCategories.map(([category, count]) => {
						const { color, label } = TOOL_CATEGORIES[category] || { color: "bg-gray-500", label: category };
						const percentage = (count / total) * 100;
						return (
							<div key={category} className="flex items-center gap-2">
								<div className={`w-3 h-3 rounded-sm ${color}`} />
								<span className="text-xs text-foreground">{label}</span>
								<span className="text-xs text-muted-foreground ml-auto">{percentage.toFixed(0)}%</span>
							</div>
						);
					})}
				</div>
			</CardContent>
		</Card>
	);
}
