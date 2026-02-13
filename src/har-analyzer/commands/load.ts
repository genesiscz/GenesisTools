import type { Command } from "commander";
import { resolve } from "node:path";
import { SessionManager } from "@app/har-analyzer/core/session-manager";
import { formatDashboard } from "@app/har-analyzer/core/formatter";

export function registerLoadCommand(program: Command): void {
	program
		.command("load <file>")
		.description("Load and index a HAR file, display dashboard")
		.action(async (file: string) => {
			const filePath = resolve(file);
			const sm = new SessionManager();
			const session = await sm.createSession(filePath);
			// Auto-cleanup old sessions (fire and forget)
			sm.cleanExpiredSessions().catch(() => {});
			console.log(formatDashboard(session.stats, session.sourceFile));
		});
}
