import { ui } from "@genesiscz/utils/cli/ui";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { runMacosDoctor } from "../../lib/doctor";
import type { DoctorCheckSummary } from "../../lib/doctor/summarize";

function printCheck(check: DoctorCheckSummary): void {
    ui.section(check.name);

    for (const line of check.lines) {
        if (check.ok) {
            ui.ok(line);
        } else {
            ui.err(line);
        }
    }
}

/** `tools macos doctor`: renders {@link runMacosDoctor}'s report and sets the exit code. */
export function registerDoctorCommand(program: Command): void {
    program
        .command("doctor")
        .description(
            "Run every read-only macOS check in one pass: GenesisTools.app and permissions, Calendar, Reminders, and Notifications. Exits 1 if any check fails."
        )
        .option("--json", "Print every report as JSON")
        .action(async (options: { json?: boolean }) => {
            const report = await runMacosDoctor();
            const { ok, checks } = report;

            if (options.json) {
                out.result(report);
            } else {
                ui.header("macOS doctor");

                for (const check of checks) {
                    printCheck(check);
                }

                ui.section("Verdict");

                if (ok) {
                    ui.ok("Every check passed.");
                } else {
                    const failed = checks.filter((c) => !c.ok).map((c) => c.name);
                    ui.err(`Failed: ${failed.join(", ")}. See the sections above for the fix.`);
                }
            }

            if (!ok) {
                process.exitCode = 1;
            }
        });
}
