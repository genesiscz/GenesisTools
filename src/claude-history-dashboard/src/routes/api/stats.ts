import { getConversationStats, getQuickStatsFromCache } from "@app/claude/lib/history/search";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/stats")({
	server: {
		handlers: {
			GET: async () => {
				const cached = getQuickStatsFromCache();

				if (cached) {
					return Response.json({
						totalConversations: cached.totalConversations,
						totalMessages: cached.totalMessages,
						subagentCount: cached.subagentCount,
						projectCount: cached.projectCount,
						isCached: true,
					});
				}

				const stats = await getConversationStats();
				return Response.json({
					totalConversations: stats.totalConversations,
					totalMessages: stats.totalMessages,
					subagentCount: stats.subagentCount,
					projectCount: Object.keys(stats.projectCounts).length,
					isCached: false,
				});
			},
		},
	},
});
