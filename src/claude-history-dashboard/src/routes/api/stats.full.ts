import {
	type DateRange,
	getConversationStatsWithCache,
} from "@app/claude/lib/history/search";
import { createFileRoute } from "@tanstack/react-router";
import type { SerializableStats } from "../../server/serializers";

export const Route = createFileRoute("/api/stats/full")({
	server: {
		handlers: {
			GET: async ({ request }: { request: Request }) => {
				const url = new URL(request.url);
				const from = url.searchParams.get("from") || undefined;
				const to = url.searchParams.get("to") || undefined;
				const refresh = url.searchParams.get("refresh") === "true";

				// Validate dates
				if (from && Number.isNaN(new Date(from).getTime())) {
					return Response.json({ error: `Invalid 'from' date: ${from}` }, { status: 400 });
				}

				if (to && Number.isNaN(new Date(to).getTime())) {
					return Response.json({ error: `Invalid 'to' date: ${to}` }, { status: 400 });
				}

				if (from && to && from > to) {
					return Response.json({ error: "'from' date must be before 'to' date" }, { status: 400 });
				}

				const dateRange: DateRange | undefined = from || to ? { from, to } : undefined;

				const stats = await getConversationStatsWithCache({
					forceRefresh: refresh,
					dateRange,
				});

				return Response.json(stats as SerializableStats);
			},
		},
	},
});
