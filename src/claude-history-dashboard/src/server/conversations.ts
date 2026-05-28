/**
 * Server Functions for Claude History Dashboard
 * Using TanStack Start's createServerFn for type-safe server/client data fetching
 */

import {
	type DateRange,
	getAvailableProjects,
	getConversationBySessionId,
	getConversationStats,
	getConversationStatsWithCache,
	getQuickStatsFromCache,
	getSessionListing,
	getStatsForDateRange,
	type SearchFilters,
	searchConversations,
} from "@app/claude/lib/history/search";
import { createServerFn } from "@tanstack/react-start";
import {
	extractMessageContent,
	extractToolResults,
	extractToolUses,
	type SerializableConversationDetail,
	type SerializableStats,
	type SidebarSession,
	serializeResult,
	serializeSessionMetadata,
	toSidebarSession,
} from "./serializers";

// Re-export types so existing consumers don't break
export type {
	QuickStatsResponse,
	SerializableConversation,
	SerializableConversationDetail,
	SerializableStats,
	SidebarSession,
	TokenUsage,
} from "./serializers";

/**
 * Get conversations with optional search/filtering
 */
export const getConversations = createServerFn({ method: "GET" })
	.inputValidator((filters: Omit<SearchFilters, "onProgress">) => filters)
	.handler(async ({ data: filters }) => {
		if (filters.query) {
			const results = await searchConversations(filters);
			return results.map(serializeResult);
		}

		const listing = await getSessionListing({
			project: filters.project,
			excludeSubagents: filters.agentsOnly ? false : filters.excludeAgents !== false,
			limit: filters.limit || 50,
		});

		return listing.sessions.map(serializeSessionMetadata);
	});

/**
 * Lightweight session list for sidebar tree (no message content)
 */
export const getSidebarSessions = createServerFn({ method: "GET" }).handler(async () => {
	const { sessions } = await getSessionListing({ limit: 200, excludeSubagents: false });

	const seen = new Set<string>();
	const sidebar: SidebarSession[] = [];

	for (const session of sessions) {
		const item = toSidebarSession(session);

		if (seen.has(item.sessionId)) {
			continue;
		}

		seen.add(item.sessionId);
		sidebar.push(item);
	}

	return sidebar;
});

/**
 * Get a single conversation by session ID with full messages
 */
export const getConversation = createServerFn({ method: "GET" })
	.inputValidator((id: string) => id)
	.handler(async ({ data: id }) => {
		const result = await getConversationBySessionId(id);

		if (!result) {
			return null;
		}

		const detail: SerializableConversationDetail = {
			...serializeResult(result),
			messages: result.matchedMessages.map((msg) => ({
				type: msg.type,
				role: "message" in msg ? (msg.message as { role?: string })?.role : undefined,
				content: extractMessageContent(msg),
				timestamp: "timestamp" in msg ? String(msg.timestamp) : undefined,
				toolUses: extractToolUses(msg),
				toolResults: extractToolResults(msg),
			})),
		};
		return detail;
	});

/**
 * Get conversation statistics (legacy - full scan)
 */
export const getStats = createServerFn({ method: "GET" }).handler(async () => {
	const stats = await getConversationStats();
	return stats as SerializableStats;
});

/**
 * Get quick stats from cache (instant, for initial page load)
 * Returns cached totals without scanning files
 */
export const getQuickStats = createServerFn({ method: "GET" }).handler(async () => {
	const cached = getQuickStatsFromCache();

	if (cached) {
		return {
			totalConversations: cached.totalConversations,
			totalMessages: cached.totalMessages,
			subagentCount: cached.subagentCount,
			projectCount: cached.projectCount,
			isCached: true,
		};
	}

	// No cache yet — warm incremental stats cache instead of full legacy scan
	await getConversationStatsWithCache({ forceRefresh: false });
	const warmed = getQuickStatsFromCache();

	if (warmed) {
		return {
			totalConversations: warmed.totalConversations,
			totalMessages: warmed.totalMessages,
			subagentCount: warmed.subagentCount,
			projectCount: warmed.projectCount,
			isCached: true,
		};
	}

	const stats = await getConversationStats();
	return {
		totalConversations: stats.totalConversations,
		totalMessages: stats.totalMessages,
		subagentCount: stats.subagentCount,
		projectCount: Object.keys(stats.projectCounts).length,
		isCached: false,
	};
});

/**
 * Validate a date range input
 */
function validateDateRange(from?: string, to?: string): { valid: boolean; error?: string } {
	if (from) {
		const fromDate = new Date(from);

		if (Number.isNaN(fromDate.getTime())) {
			return { valid: false, error: `Invalid 'from' date: ${from}` };
		}
	}

	if (to) {
		const toDate = new Date(to);

		if (Number.isNaN(toDate.getTime())) {
			return { valid: false, error: `Invalid 'to' date: ${to}` };
		}
	}

	if (from && to && from > to) {
		return { valid: false, error: `'from' date must be before 'to' date` };
	}

	return { valid: true };
}

/**
 * Get full stats with caching (incremental updates)
 * Optionally filter by date range
 */
export const getFullStats = createServerFn({ method: "GET" })
	.inputValidator((input: { from?: string; to?: string; forceRefresh?: boolean }) => input)
	.handler(async ({ data }) => {
		// Validate date range if provided
		const validation = validateDateRange(data.from, data.to);

		if (!validation.valid) {
			throw new Error(validation.error);
		}

		const dateRange: DateRange | undefined = data.from || data.to ? { from: data.from, to: data.to } : undefined;

		const stats = await getConversationStatsWithCache({
			forceRefresh: data.forceRefresh,
			dateRange,
		});

		return stats as SerializableStats;
	});

/**
 * Get stats for a specific date range from cache
 */
export const getStatsInRange = createServerFn({ method: "GET" })
	.inputValidator((input: { from: string; to: string }) => input)
	.handler(async ({ data }) => {
		// Validate date range
		const validation = validateDateRange(data.from, data.to);

		if (!validation.valid) {
			throw new Error(validation.error);
		}

		const stats = await getStatsForDateRange({ from: data.from, to: data.to });
		return stats as SerializableStats;
	});

/**
 * Get available projects
 */
export const getProjects = createServerFn({ method: "GET" }).handler(async () => {
	return getAvailableProjects();
});
