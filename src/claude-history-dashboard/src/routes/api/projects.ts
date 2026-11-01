import { history } from "@app/claude-history-dashboard/src/server/history";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/projects")({
	server: {
		handlers: {
			GET: async () => {
				const { getAvailableProjects } = await history();
				const projects = await getAvailableProjects();
				return Response.json(projects);
			},
		},
	},
});
