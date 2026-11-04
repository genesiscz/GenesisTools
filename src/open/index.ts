#!/usr/bin/env bun

import { runTool } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, truncateDisplay } from "@genesiscz/utils/table";
import { Command } from "commander";
import pc from "picocolors";
import { openAndLog, openLogPath, readOpenRecords } from "./lib/opens";

const program = new Command();

program
    .name("open")
    .enablePositionalOptions()
    .description(
        "Open files, folders and URLs the way macOS `open` does, and log each open with the agent that asked for it (harness, session, project, branch)"
    )
    .argument("[targets...]", "files, folders or URLs")
    .option("-a, --app <app>", "open with this app (open -a)")
    .option("-b, --bundle <id>", "open with the app of this bundle id (open -b)")
    .option("-R, --reveal", "reveal in Finder instead of opening (open -R)")
    .option("-g, --background", "do not bring the app to the front (open -g)")
    .option("--why <text>", "why it is opened, kept in the log")
    .option("--json", "print the logged record as JSON")
    .action(
        async (
            targets: string[],
            flags: {
                app?: string;
                bundle?: string;
                reveal?: boolean;
                background?: boolean;
                why?: string;
                json?: boolean;
            }
        ) => {
            if (targets.length === 0) {
                program.help();
            }

            const record = await openAndLog({
                targets,
                app: flags.app,
                bundleId: flags.bundle,
                reveal: flags.reveal,
                background: flags.background,
                why: flags.why,
            });

            if (flags.json) {
                out.result(record);
            }

            for (const target of record.targets.filter((one) => one.kind === "missing")) {
                out.log.warn(`${target.given}: no such file or folder (${target.path})`);
            }

            if (record.exitCode !== 0) {
                out.log.error(record.stderr ?? `open exited ${record.exitCode}`);
                process.exitCode = record.exitCode;
            }
        }
    );

program
    .command("log")
    .description("The logged opens, newest first, with the agent and session that opened each")
    .option("-n, --limit <n>", "how many", "20")
    .option("--session <id>", "only opens by this agent session (an id prefix)")
    .option("--json", "print JSON")
    .action((flags: { limit: string; session?: string; json?: boolean }) => {
        const records = readOpenRecords({ limit: Number(flags.limit) || 20, sessionId: flags.session });

        if (flags.json) {
            out.result(records);
            return;
        }

        if (records.length === 0) {
            out.println(pc.dim(`No opens logged yet (${openLogPath()}).`));
            return;
        }

        const table = createBoxTable(["WHEN", "OPENED", "HOW", "AGENT", "SESSION", "PROJECT", "WHY"]);

        for (const record of records) {
            const how = [
                record.reveal ? "reveal" : undefined,
                record.app ?? record.bundleId,
                record.exitCode ? `exit ${record.exitCode}` : undefined,
            ]
                .filter(Boolean)
                .join(", ");
            table.push([
                new Date(record.at).toLocaleString("cs-CZ", { timeZone: "Europe/Prague" }),
                truncateDisplay(record.targets.map((target) => target.path ?? target.given).join("\n"), 70),
                how || "open",
                record.caller.agent,
                truncateDisplay(record.caller.sessionId?.slice(0, 8), 8),
                truncateDisplay(record.caller.project, 20),
                truncateDisplay(record.why, 30),
            ]);
        }

        out.println(table.toString());
        out.println(pc.dim(`log: ${openLogPath()}`));
    });

await runTool(program, { tool: "open" });
