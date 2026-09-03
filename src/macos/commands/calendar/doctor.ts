import { ui } from "@genesiscz/utils/cli/ui";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { type CalendarDoctorReport, runCalendarDoctor } from "../../lib/calendar/doctor";

function printReport(report: CalendarDoctorReport): void {
    ui.header("Calendar access");
    const statusLine = report.promptSkipped
        ? "not read (reading it would show the macOS permission dialog)"
        : `${report.status}${report.authorized ? "" : " (not enough to read events)"}`;

    if (report.authorized) {
        ui.ok(statusLine);
    } else {
        ui.err(statusLine);
    }

    ui.kv(
        "calendars",
        String(report.calendarCount) + (report.placeholderOnly ? " (EventKit placeholder only)" : ""),
        11
    );
    ui.kv("sources", report.sources.map((s) => `${s.title} [${s.source_type}]`).join(", ") || "none", 11);

    ui.section("This process");
    const responsible = report.hostApp.responsible;
    ui.kv(
        "responsible",
        responsible.kind === "genesis-app"
            ? `GenesisTools.app (${responsible.bundleId})`
            : responsible.kind === "host-app"
              ? `${responsible.bundleId} (launching app; build GenesisTools.app to own the grants)`
              : "unknown (no bundle; launchd or a bare shell)",
        11
    );
    ui.kv("host app", report.hostApp.bundleId ?? "none", 11);
    ui.kv("terminal", report.hostApp.termProgram ?? "unknown", 11);
    ui.kv("darwinkit", report.binary.path, 11);
    ui.kv(
        "Info.plist",
        report.binary.inAppBundle
            ? `.app bundle, ${report.binary.hasCalendarUsageString ? "has" : "lacks"} NSCalendarsFullAccessUsageDescription (irrelevant: TCC asks the host app, not the child)`
            : "none (bare binary; TCC asks the host app, not the child)",
        11
    );

    ui.section("What macOS granted (TCC.db, kTCCServiceCalendar)");

    if (!report.tcc.readable) {
        ui.warn(`TCC.db not readable: ${report.tcc.error ?? "unknown error"}. Grant Full Disk Access to read it.`);
    } else if (report.tcc.rows.length === 0) {
        ui.info("no Calendar rows at all");
    } else {
        for (const row of report.tcc.rows) {
            const mine = row.client === report.hostApp.responsible.bundleId ? "  <- this process" : "";
            const line = `${row.client}: ${row.label}${mine}`;

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
            "Explain whether this process may read the calendar: authorization status, calendar count, host app, TCC grants. Read-only: with no recorded grant it reports that instead of asking, because the macOS dialog writes a durable TCC row."
        )
        .option("--json", "Print the report as JSON")
        .option("--request-access", "Read the status even when that shows the macOS permission dialog")
        .action(async (options: { json?: boolean; requestAccess?: boolean }) => {
            const report = await runCalendarDoctor({ requestAccess: options.requestAccess });

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
