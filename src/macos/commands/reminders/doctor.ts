import { ui } from "@genesiscz/utils/cli/ui";
import { out } from "@genesiscz/utils/logger";
import { genesisAppBuildHint } from "@genesiscz/utils/macos/xcode";
import type { Command } from "commander";
import { tccRowLine } from "../../lib/calendar/doctor";
import { type RemindersDoctorReport, runRemindersDoctor } from "../../lib/reminders/doctor";

function printReport(report: RemindersDoctorReport): void {
    ui.header("Reminders access");
    const statusLine = report.promptSkipped
        ? "not read (reading it would show the macOS permission dialog)"
        : `${report.status}${report.authorized ? "" : " (not enough to read reminders)"}`;

    if (report.authorized) {
        ui.ok(statusLine);
    } else {
        ui.err(statusLine);
    }

    ui.kv("lists", String(report.listCount), 11);

    ui.section("This process");
    const responsible = report.hostApp.responsible;
    ui.kv(
        "responsible",
        responsible.kind === "genesis-app"
            ? `GenesisTools.app (${responsible.bundleId})`
            : responsible.kind === "host-app"
              ? `${responsible.bundleId} (launching app; build GenesisTools.app to own the grants — ${genesisAppBuildHint()})`
              : "unknown (no bundle; launchd or a bare shell)",
        11
    );
    ui.kv("host app", report.hostApp.bundleId ?? "none", 11);
    ui.kv("terminal", report.hostApp.termProgram ?? "unknown", 11);
    ui.kv("darwinkit", report.binary.path, 11);
    ui.kv(
        "Info.plist",
        report.binary.inAppBundle
            ? `.app bundle, ${report.binary.hasRemindersUsageString ? "has" : "lacks"} NSRemindersFullAccessUsageDescription (irrelevant: TCC asks the host app, not the child)`
            : "none (bare binary; TCC asks the host app, not the child)",
        11
    );

    ui.section("What macOS granted (TCC.db, kTCCServiceReminders)");

    if (!report.tcc.readable) {
        ui.warn(`TCC.db not readable: ${report.tcc.error ?? "unknown error"}. Grant Full Disk Access to read it.`);
    } else if (report.tcc.rows.length === 0) {
        ui.info("no Reminders rows at all");
    } else {
        const client = { bundleId: report.hostApp.responsible.bundleId, executablePath: report.hostApp.executablePath };

        for (const row of report.tcc.rows) {
            const line = tccRowLine(row, client);

            if (row.authValue === 2) {
                ui.ok(line);
            } else {
                ui.warn(line);
            }
        }
    }

    ui.section("Verdict");

    if (report.fix) {
        ui.err(report.verdict);
        ui.raw(`  Fix: ${report.fix}`);
    } else {
        ui.ok(report.verdict);
    }
}

export function registerDoctorCommand(program: Command): void {
    program
        .command("doctor")
        .description(
            "Explain whether this process may read Reminders: authorization status, list count, host app, TCC grants. Read-only: with no recorded grant it reports that instead of asking, because the macOS dialog writes a durable TCC row."
        )
        .option("--json", "Print the report as JSON")
        .option("--request-access", "Ask macOS for Reminders access when it has not asked yet (shows the dialog)")
        .action(async (options: { json?: boolean; requestAccess?: boolean }) => {
            const report = await runRemindersDoctor({ requestAccess: options.requestAccess });

            if (options.json) {
                out.result(report);
            } else {
                printReport(report);
            }

            if (report.fix) {
                process.exitCode = 1;
            }
        });
}
