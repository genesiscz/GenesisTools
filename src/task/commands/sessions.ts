import { out } from "@app/logger";
import { formatSessionState } from "@app/task/lib/format-session-state";
import { formatSessionsJson } from "@app/task/lib/format-sessions-json";
import { sessionFilePaths } from "@app/task/lib/paths";
import { TaskSessionStore } from "@app/task/lib/session-store";
import { formatBytes } from "@app/utils/format";
import { SafeJSON } from "@app/utils/json";
import type { Command } from "commander";

export function registerSessionsCommand(program: Command): void {
    program
        .command("sessions")
        .description("List task sessions")
        .option("--json", "Emit machine-readable JSON array on stdout")
        .action(async (opts: { json?: boolean }) => {
            if (opts.json) {
                const data = await formatSessionsJson();
                out.result(SafeJSON.stringify(data, null, 2));
                return;
            }

            const store = new TaskSessionStore();
            const names = await store.listSessionNames();

            if (names.length === 0) {
                out.printlnErr("No task sessions found.");
                return;
            }

            out.printlnErr("");
            out.printlnErr("Task sessions:");
            out.printlnErr("");

            for (const name of names.sort()) {
                const meta = await store.reconcileSessionState(name);
                const paths = sessionFilePaths(name);
                const jsonlSize = await store.getSessionFileSize(paths.jsonl);
                const state = formatSessionState(meta);
                out.printlnErr(`  ${name.padEnd(24)} ${state.padEnd(16)} ${formatBytes(jsonlSize)}`);
            }

            out.printlnErr("");
        });
}
