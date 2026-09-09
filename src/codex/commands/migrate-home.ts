import { homedir } from "node:os";
import { join } from "node:path";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import { expandTilde } from "@genesiscz/utils/paths";
import * as p from "@genesiscz/utils/prompts/p";
import {
    createBoxTable,
    formatDotStatus,
    renderCliHeader,
    renderCliKeyRow,
    renderCliSection,
} from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import {
    type BusyReport,
    type MigrateHomeOptions,
    type MigrateHomeReport,
    migrateHome,
    previewDesktopMerge,
} from "../lib/migrate-home";

const { log } = logger.scoped("codex-migrate-home");

export interface MigrateHomeCliOptions {
    from?: string[];
    to?: string;
    apply?: boolean;
    desktop?: boolean;
    archiveSource?: boolean;
    json?: boolean;
}

function homeList(values: string[] | undefined): string[] {
    return (values ?? [])
        .flatMap((value) => value.split(","))
        .map((value) => expandTilde(value.trim()))
        .filter((value) => value.length > 0);
}

function busyCell(busy: BusyReport): string {
    if (busy.status === "clear") {
        return formatDotStatus("ok", "clear");
    }

    if (busy.status === "busy") {
        return formatDotStatus("err", "in use");
    }

    return formatDotStatus("warn", "unknown");
}

function renderReport(report: MigrateHomeReport): void {
    renderCliHeader("Codex migrate-home", report.applied ? "applied" : "dry run, nothing written");

    const homes = createBoxTable(["HOME", "STATE", "HELD BY"]);

    for (const busy of report.busy) {
        const holders = [...new Set(busy.holders.map((holder) => `${holder.command}(${holder.pid})`))];
        homes.push([
            busy.home === report.destination ? `${busy.home} ${pc.dim("(destination)")}` : busy.home,
            busyCell(busy),
            holders.length > 0 ? holders.join(" ") : pc.dim("—"),
        ]);
    }

    out.println(homes.toString());

    if (report.sources.length > 0) {
        const sources = createBoxTable(["SOURCE", "ROLLOUTS", "TO COPY", "ALREADY THERE", "COLLISIONS", "COPIED"]);

        for (const source of report.sources) {
            sources.push([
                source.home,
                String(source.rollouts),
                String(source.toCopy),
                String(source.alreadyPresent),
                source.collisions.length > 0 ? pc.red(String(source.collisions.length)) : "0",
                String(source.copied),
            ]);
        }

        out.println(sources.toString());
    }

    for (const source of report.sources) {
        for (const collision of source.collisions) {
            out.println(
                `  ${pc.red("collision")} ${collision.nativeId}\n    source      ${collision.sourcePath}\n    destination ${collision.destinationPath}\n    payload.id  ${collision.sourceMeta.id ?? "—"} vs ${collision.destinationMeta.id ?? "—"}\n    session_id  ${collision.sourceMeta.sessionId ?? "—"} vs ${collision.destinationMeta.sessionId ?? "—"}`
            );
        }
    }

    if (report.desktop.length > 0) {
        renderCliSection("Codex Desktop state");

        for (const desktop of report.desktop) {
            renderCliKeyRow("source", desktop.home, 18);
            renderCliKeyRow("projects added", String(desktop.projectsAdded.length), 18);
            renderCliKeyRow("duplicates avoided", String(desktop.duplicatesAvoided.length), 18);
            renderCliKeyRow("order appended", String(desktop.orderAppended.length), 18);
            renderCliKeyRow(
                "assignments",
                `${desktop.assignmentsAdded} added (${desktop.assignmentsRemapped} remapped), ${desktop.assignmentsKept} kept`,
                18
            );
            renderCliKeyRow("written", desktop.written ? "yes" : pc.dim("no, dry run"), 18);
        }
    }

    if (report.backups.sessions || report.backups.globalState) {
        renderCliSection("Backups");
        renderCliKeyRow("sessions", report.backups.sessions ?? "—", 14);
        renderCliKeyRow("desktop state", report.backups.globalState ?? "—", 14);
        renderCliKeyRow("source", "untouched; the copy never unlinks", 14);
    }

    for (const source of report.sources) {
        if (source.archivedTo) {
            renderCliKeyRow("archived", source.archivedTo, 14);
        }
    }

    if (report.refusals.length > 0) {
        renderCliSection("Refused");

        for (const refusal of report.refusals) {
            out.println(`  ${pc.red("✖")} ${pc.dim(`[${refusal.reason}]`)} ${refusal.detail}`);
        }
    }

    renderCliSection("Next");
    renderCliKeyRow("reindex", report.reindexCommand, 12);
    renderCliKeyRow("provenance", report.provenanceNote, 12);
}

export async function runMigrateHome(options: MigrateHomeCliOptions): Promise<void> {
    const destination = expandTilde(options.to ?? join(homedir(), ".codex"));
    const from = homeList(options.from);
    const interactive = isInteractive();
    const base: MigrateHomeOptions = { from: from.length > 0 ? from : undefined, to: destination };

    let desktop = options.desktop === true;
    let archiveSource = options.archiveSource === true;
    let apply = options.apply === true;

    if (!apply && !interactive && !options.json) {
        out.log.info(
            `Dry run. ${suggestCommand("tools codex migrate-home", { add: ["--apply"], subcommand: ["migrate-home"] })}`
        );
    }

    if (!options.desktop && interactive && !options.json) {
        desktop = await p.confirm({
            message: "Also merge Codex Desktop projects and thread assignments?",
            initialValue: false,
        });
    }

    let report = await migrateHome({ ...base, apply, desktop, archiveSource });

    // The Desktop merge only writes under --apply, so a dry run has to compute the same diff a
    // second way to be able to show it at all.
    if (desktop && !report.applied && report.refusals.length === 0) {
        report.desktop = await previewDesktopMerge(
            report.destination,
            report.sources.map((source) => source.home)
        );
    }

    if (options.json) {
        out.result(report);
        process.exitCode = report.refusals.length > 0 ? 1 : 0;
        return;
    }

    renderReport(report);

    if (report.refusals.length > 0) {
        process.exitCode = 1;
        return;
    }

    if (report.applied || report.totals.toCopy === 0 || !interactive) {
        return;
    }

    const proceed = await p.confirm({
        message: `Copy ${report.totals.toCopy} rollout(s) into ${report.destination} now?`,
        initialValue: false,
        danger: true,
    });

    if (!proceed) {
        out.log.info("Nothing was written.");
        return;
    }

    if (!options.archiveSource) {
        archiveSource = await p.confirm({
            message: "Rename each source sessions/ to sessions.migrated-<stamp> after the copy verifies?",
            initialValue: false,
        });
    }

    apply = true;
    report = await migrateHome({ ...base, apply, desktop, archiveSource });
    renderReport(report);
    log.info({ totals: report.totals, applied: report.applied }, "migrate-home finished");

    if (report.refusals.length > 0) {
        process.exitCode = 1;
    }
}

export function registerMigrateHomeCommand(program: Command): void {
    program
        .command("migrate-home")
        .description("Merge other Codex homes' transcripts (and optionally Desktop projects) into one home")
        .option(
            "--from <home...>",
            "Source homes; repeatable or comma-separated. Default: every ~/.codex-* sibling holding sessions"
        )
        .option("--to <home>", "Destination home (default ~/.codex)")
        .option("--apply", "Perform the migration; without it the command only reports")
        .option("--desktop", "Also merge .codex-global-state.json projects and thread assignments")
        .option("--archive-source", "Rename each source sessions/ to sessions.migrated-<stamp> after a verified copy")
        .option("--json", "Emit the machine-readable report")
        .action(runMigrateHome);
}
