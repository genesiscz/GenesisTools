import { resolve } from "node:path";
import { isWatchDriverId, WATCH_DRIVER_IDS } from "@genesiscz/utils/fs/watch-driver/registry";
import { callWorktreeSnapshot, requestServiceStart } from "@genesiscz/utils/genesis-tools/worktree/thin-client";
import { out } from "@genesiscz/utils/logger";
import { formatTable } from "@genesiscz/utils/table";
import type { Command } from "commander";

const DEADLINE_MS = 3_000;

export function registerWorktreeCommand(program: Command): void {
    const worktree = program
        .command("worktree")
        .description("The Git status of worktrees that the GenesisTools service keeps current with a file watcher");

    worktree
        .command("snapshot <root>")
        .description("Ask the service for the Git status of one worktree (the first call opens the watch: opening)")
        .option("--driver <id>", `the watch driver: ${WATCH_DRIVER_IDS.join(", ")}`, "watchman")
        .option("--since <mark>", "the mark of an earlier answer, to get the paths that changed since")
        .option("--json", "print the answer as JSON")
        .action(async (root: string, options: { driver: string; since?: string; json?: boolean }) => {
            if (!isWatchDriverId(options.driver)) {
                out.println(`--driver takes ${WATCH_DRIVER_IDS.join(", ")}, not ${options.driver}`);
                process.exitCode = 1;
                return;
            }

            const call = await callWorktreeSnapshot(
                { root: resolve(root), driver: options.driver, ...(options.since ? { since: options.since } : {}) },
                { deadlineMs: DEADLINE_MS }
            );

            if (!call.ok && call.reason === "no-service") {
                requestServiceStart({ cooldownMs: 0 });
            }

            if (options.json) {
                out.result(call.ok ? call.result : { state: "unavailable", reason: call.reason });
                return;
            }

            if (!call.ok) {
                out.println(
                    `no answer: ${call.reason}${call.reason === "no-service" ? " (a start was requested)" : ""}`
                );
                return;
            }

            const result = call.result;

            if (result.state !== "ok") {
                out.println(`unavailable: ${result.reason}`);
                return;
            }

            out.println(`${result.source}, ${result.entries.length} entries, head ${result.head ?? "none"}`);
            out.println(
                formatTable(
                    result.entries.map((entry) => [`${entry.index}${entry.worktree}`, entry.path]),
                    ["status", "path"]
                )
            );
            out.println(`mark: ${result.mark}`);
        });

    worktree
        .command("watchers")
        .description("List the worktrees the running service watches; opens no root")
        .option("--json", "print the list as JSON")
        .action(async (options: { json?: boolean }) => {
            const { callRunningService } = await import("@genesiscz/utils/genesis-tools/service/clients");
            const call = await callRunningService("worktree.watchers", {}, DEADLINE_MS);

            if (!call.called) {
                out.println("no service is running");
                return;
            }

            if (options.json) {
                out.result(call.value);
                return;
            }

            const rows = Array.isArray(call.value)
                ? call.value.map((row: unknown) => {
                      const fields = typeof row === "object" && row !== null ? row : {};
                      const text = (key: string) => {
                          const value = Object.entries(fields).find(([name]) => name === key)?.[1];
                          return typeof value === "string" ? value : "";
                      };
                      return [text("driver"), text("root"), text("lastAnswerAt") || "never"];
                  })
                : [];
            out.println(formatTable(rows, ["driver", "root", "last answer"]));
        });
}
