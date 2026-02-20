import { formatDashboard, printFormatted } from "@app/har-analyzer/core/formatter";
import { SessionManager } from "@app/har-analyzer/core/session-manager";
import type { OutputOptions } from "@app/har-analyzer/types";
import type { Command } from "commander";

export function registerDashboardCommand(program: Command): void {
    program
        .command("dashboard")
        .description("Show overview dashboard for loaded HAR")
        .action(async () => {
            const parentOpts = program.opts<OutputOptions>();
            const sm = new SessionManager();
            const session = await sm.requireSession(parentOpts.session);

            await printFormatted(formatDashboard(session.stats, session.sourceFile), parentOpts.format);
        });
}
