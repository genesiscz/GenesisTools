import { getAvailableProjects } from "@app/claude/lib/history/search";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/projects")({
	server: {
		handlers: {
			GET: async () => {
				const projects = await getAvailableProjects();
				return Response.json(projects);
			},
		},
	},
});
