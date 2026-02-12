import type { Command } from "commander";
import { SessionManager } from "@app/har-analyzer/core/session-manager";
import { formatDashboard } from "@app/har-analyzer/core/formatter";

export function registerDashboardCommand(program: Command): void {
	program
		.command("dashboard")
		.description("Show overview dashboard for loaded HAR")
		.action(async () => {
			const sm = new SessionManager();
			const session = await sm.loadSession();

			if (!session) {
				console.error("No session loaded. Use `load <file>` first.");
				process.exit(1);
			}

			console.log(formatDashboard(session.stats, session.sourceFile));
		});
}
