import { type DoctorLevel, type DoctorReport, runDoctor } from "@genesiscz/utils/ai/config/doctor";
import { out } from "@genesiscz/utils/logger";
import {
    createBoxTable,
    type DotStatusKind,
    formatDotStatus,
    renderCliHeader,
    renderCliSection,
    truncateDisplay,
} from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

/**
 * `tools ai config doctor` — the whole configuration, checked and rendered.
 *
 * The report is never massaged to look green: a check that fails is printed as
 * failing and the exit code follows it, because a doctor that reassures is worse
 * than no doctor.
 */

const STATUS: Record<DoctorLevel, { kind: DotStatusKind; label: string }> = {
    ok: { kind: "ok", label: "ok" },
    warn: { kind: "warn", label: "warn" },
    err: { kind: "err", label: "fail" },
};

export function printDoctorReport(report: DoctorReport): void {
    renderCliHeader("AI config doctor", `${report.checks.length} checks`);

    const table = createBoxTable(["CHECK", "SCOPE", "STATUS", "DETAIL"]);
    for (const check of report.checks) {
        const status = STATUS[check.level];
        table.push([
            truncateDisplay(check.id, 20),
            truncateDisplay(check.scope, 22),
            formatDotStatus(status.kind, status.label),
            truncateDisplay(check.detail, 68),
        ]);
    }

    out.println(table.toString());

    renderCliSection("Summary");
    out.println(
        `  ${pc.green(`${report.counts.ok} ok`)} · ${pc.yellow(`${report.counts.warn} warn`)} · ${pc.red(
            `${report.counts.err} fail`
        )}`
    );

    if (!report.ok) {
        out.println(`  ${pc.dim("Fix the failing rows above; each detail names the command that repairs it.")}`);
    }
}

export async function cmdDoctor(flags: { json?: boolean; live?: boolean }): Promise<DoctorReport> {
    const report = await runDoctor({ live: flags.live });

    if (flags.json) {
        out.result(report);
    } else {
        printDoctorReport(report);
    }

    if (!report.ok) {
        process.exitCode = 1;
    }

    return report;
}

export function registerDoctorCommand(config: Command): void {
    config
        .command("doctor")
        .description("Diagnose the master key, the vault, every account credential, links and expiries")
        .option("--json", "Emit the full report as JSON")
        .option("--live", "Also run provider health probes (may touch the network)")
        .action(async (flags: { json?: boolean; live?: boolean }) => {
            await cmdDoctor(flags);
        });
}
