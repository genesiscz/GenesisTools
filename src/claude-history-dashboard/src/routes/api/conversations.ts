import {
	getAllConversations,
	type SearchFilters,
	searchConversations,
} from "@app/claude/lib/history/search";
import { createFileRoute } from "@tanstack/react-router";
import { serializeResult } from "../../server/serializers";

export const Route = createFileRoute("/api/conversations")({
	server: {
		handlers: {
			GET: async ({ request }: { request: Request }) => {
				const url = new URL(request.url);
				const rawLimit = Number(url.searchParams.get("limit"));
				const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 50;
				const query = url.searchParams.get("q") || undefined;
				const project = url.searchParams.get("project") || undefined;

				const filters: Omit<SearchFilters, "onProgress"> = { limit, query, project };

				const results = query
					? await searchConversations(filters)
					: await getAllConversations({ ...filters, limit });

				return Response.json(results.map(serializeResult));
			},
		},
	},
});
