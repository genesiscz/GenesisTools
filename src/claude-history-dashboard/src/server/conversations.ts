/**
 * Server Functions for Claude History Dashboard
 * Using TanStack Start's createServerFn for type-safe server/client data fetching
 */

import { basename } from "node:path";
import type { DateRange, SearchFilters } from "@app/claude/lib/history/search";
import type { SessionMetadataRecord } from "@genesiscz/utils/agent-sessions/cache-types";
import type { AgentSearchFilters } from "@genesiscz/utils/agent-sessions/types";
import { resolveProjectDir } from "@genesiscz/utils/claude/projects";
import { createServerFn } from "@tanstack/react-start";
import { history } from "./history";
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
 * Claude's sessions off the shared history index, newest first, as the serializers read them. Loaded on the first
 * call for the reason `history` is (see `./history`): the catalog reaches the provider registry too.
 */
async function claudeSessions(filters: AgentSearchFilters): Promise<SessionMetadataRecord[]> {
	const [{ catalogHistory }, { toSessionMetadataRecord }] = await Promise.all([
		import("@genesiscz/utils/agent-sessions/open-service"),
		import("@genesiscz/utils/agent-sessions/cache-repository"),
	]);
	const { metadata } = await catalogHistory({ provider: "claude", filters });
	return metadata.map(toSessionMetadataRecord);
}

/**
 * Get conversations with optional search/filtering
 */
export const getConversations = createServerFn({ method: "GET" })
	.inputValidator((filters: Omit<SearchFilters, "onProgress">) => filters)
	.handler(async ({ data: filters }) => {
		if (filters.query) {
			const { searchConversations } = await history();
			const results = await searchConversations(filters);
			return results.map(serializeResult);
		}

		// A project name lists the one Claude project folder it resolves to; a name that resolves to none lists
		// every project.
		const projectDir = filters.project ? resolveProjectDir(filters.project) : undefined;
		const sessions = await claudeSessions({
			project: projectDir ? basename(projectDir) : undefined,
			excludeAgents: !filters.agentsOnly && filters.excludeAgents !== false,
			limit: filters.limit || 50,
		});

		return sessions.map(serializeSessionMetadata);
	});

/**
 * Lightweight session list for sidebar tree (no message content)
 */
export const getSidebarSessions = createServerFn({ method: "GET" }).handler(async () => {
	const sessions = await claudeSessions({ limit: 200 });

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
		const { getConversationBySessionId } = await history();
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
 * Get conversation statistics from the cached statistics pipeline
 */
export const getStats = createServerFn({ method: "GET" }).handler(async () => {
	const { getConversationStatsWithCache } = await history();
	const stats = await getConversationStatsWithCache({ forceRefresh: false });
	return stats as SerializableStats;
});

/**
 * Get quick stats from cache (instant, for initial page load)
 * Returns cached totals without scanning files
 */
export const getQuickStats = createServerFn({ method: "GET" }).handler(async () => {
	const { getConversationStatsWithCache, getQuickStatsFromCache } = await history();
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

	// No cache yet: warm the incremental statistics cache
	const stats = await getConversationStatsWithCache({ forceRefresh: false });
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

		const { getConversationStatsWithCache } = await history();
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

		const { getStatsForDateRange } = await history();
		const stats = await getStatsForDateRange({ from: data.from, to: data.to });
		return stats as SerializableStats;
	});

/**
 * Get available projects
 */
export const getProjects = createServerFn({ method: "GET" }).handler(async () => {
	const { getAvailableProjects } = await history();
	return getAvailableProjects();
});
