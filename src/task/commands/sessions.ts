import { formatBytes } from "@app/utils/format";
import type { Command } from "commander";
import { sessionFilePaths } from "../lib/paths";
import { TaskSessionStore } from "../lib/session-store";
import { statusLine } from "../lib/stderr-status";

export function registerSessionsCommand(program: Command): void {
    program
        .command("sessions")
        .description("List task sessions")
        .action(async () => {
            const store = new TaskSessionStore();
            const names = await store.listSessionNames();

            if (names.length === 0) {
                statusLine("No task sessions found.");
                return;
            }

            statusLine("");
            statusLine("Task sessions:");
            statusLine("");

            for (const name of names.sort()) {
                const meta = await store.getSessionMeta(name);
                const paths = sessionFilePaths(name);
                const jsonlSize = await store.getSessionFileSize(paths.jsonl);
                const state = meta?.exitCode !== undefined ? `exited (${meta.exitCode})` : "active";
                statusLine(`  ${name.padEnd(24)} ${state.padEnd(16)} ${formatBytes(jsonlSize)}`);
            }

            statusLine("");
        });
}
