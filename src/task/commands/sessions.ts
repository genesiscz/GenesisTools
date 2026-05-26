import { out } from "@app/logger";
import { formatBytes } from "@app/utils/format";
import type { Command } from "commander";
import { sessionFilePaths } from "../lib/paths";
import { TaskSessionStore } from "../lib/session-store";

export function registerSessionsCommand(program: Command): void {
    program
        .command("sessions")
        .description("List task sessions")
        .action(async () => {
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
                const state = meta?.exitCode !== undefined ? `exited (${meta.exitCode})` : "active";
                out.printlnErr(`  ${name.padEnd(24)} ${state.padEnd(16)} ${formatBytes(jsonlSize)}`);
            }

            out.printlnErr("");
        });
}
