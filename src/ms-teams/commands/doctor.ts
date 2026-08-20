import { inspectDoctor } from "@app/ms-teams/lib/doctor";
import { suggestCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, formatDotStatus, renderCliHeader } from "@genesiscz/utils/table";
import type { Command } from "commander";

export function registerDoctorCommand(program: Command): void {
    program
        .command("doctor")
        .description("Read-only check of Teams data paths and the local cache")
        .action(() => {
            const report = inspectDoctor();
            renderCliHeader("Teams doctor", "does not write");
            const table = createBoxTable(["CHECK", "STATUS"]);
            table.push([
                "IndexedDB",
                formatDotStatus(
                    report.idbExists && report.readable ? "ok" : "err",
                    report.idbExists ? (report.readable ? "readable" : "not readable") : "missing"
                ),
            ]);
            table.push([
                "Blob dir",
                formatDotStatus(report.blobExists ? "ok" : "warn", report.blobExists ? "present" : "missing"),
            ]);
            table.push([
                "Python venv",
                formatDotStatus(
                    report.venvPythonExists ? "ok" : "warn",
                    report.venvPythonExists ? "present" : "run sync"
                ),
            ]);
            table.push([
                "Teams process",
                formatDotStatus(report.teamsProcess ? "ok" : "dim", report.teamsProcess ? "running" : "not running"),
            ]);
            table.push([
                "SQLite cache",
                formatDotStatus(
                    report.cacheExists ? "ok" : "warn",
                    report.cacheExists ? (report.cacheIngestedAt ?? "present") : "missing"
                ),
            ]);
            out.println(table.toString());
            out.println(`IndexedDB: ${report.idbPath}`);
            out.println(`Cache: ${report.cachePath}`);

            if (report.counts) {
                out.println(
                    `Counts: ${report.counts.conversations} chats, ${report.counts.messages} messages, ${report.counts.people} people, ${report.counts.calls} calls`
                );
            }

            if (report.idbExists && !report.readable) {
                out.println(
                    "Full Disk Access: System Settings → Privacy & Security → Full Disk Access → enable your terminal, then restart it."
                );
            }

            if (!report.cacheExists) {
                out.println(suggestCommand("tools ms-teams", { replaceCommand: ["sync"] }));
            }
        });
}
