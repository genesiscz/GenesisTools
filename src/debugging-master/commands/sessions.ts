import { basename } from "node:path";
import { ACTIVE_THRESHOLD_MS, SessionManager } from "@app/debugging-master/core/session-manager";
import { suggestCommand } from "@app/utils/cli/executor";
import { formatDuration, formatRelativeTime } from "@app/utils/format";
import { formatTable } from "@app/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

const TOOL = "tools debugging-master";

export function registerSessionsCommand(program: Command): void {
    program
        .command("sessions")
        .description("List all debugging sessions")
        .action(async () => {
            const sm = new SessionManager();
            const names = await sm.listSessionNames();

            if (names.length === 0) {
                console.log("No sessions found.");
                console.log(`Start one: ${suggestCommand(TOOL, { add: ["start", "--session", "<name>"] })}`);
                return;
            }

            const headers = ["Name", "Entries", "Span", "Project", "Last Activity", ""];
            const rows: string[][] = [];

            for (const name of names) {
                const meta = await sm.getSessionMeta(name);
                const entries = await sm.readEntries(name);
                const entryCount = entries.length;

                const timestamps = entries.filter((e) => e.ts > 0).map((e) => e.ts);
                const spanMs = timestamps.length >= 2 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;

                const lastActivity = meta?.lastActivityAt ?? 0;
                const isActive = lastActivity > 0 && Date.now() - lastActivity < ACTIVE_THRESHOLD_MS;
                const project = meta?.projectPath ? basename(meta.projectPath) : "unknown";

                const lastActivityStr =
                    lastActivity > 0 ? formatRelativeTime(new Date(lastActivity), { compact: true }) : "unknown";

                rows.push([
                    name,
                    String(entryCount),
                    formatDuration(spanMs, "ms"),
                    project,
                    lastActivityStr,
                    isActive ? pc.green("active") : "",
                ]);
            }

            console.log(pc.bold("Sessions:\n"));
            console.log(formatTable(rows, headers, { alignRight: [1] }));
        });
}
