import { homedir } from "node:os";
import { join } from "node:path";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import { expandTilde } from "@genesiscz/utils/paths";
import type { OpenFilesQuery, OpenFilesResult } from "@genesiscz/utils/process/open-files";
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
        return formatDotStatus("warn", "in use");
    }

    return formatDotStatus("warn", "unknown");
}

/**
 * State databases that REFUSED a name write, which is a failure and must not exit 0.
 *
 * Deliberately excludes `stateSkippedBusy`: a database a live Codex holds is skipped on purpose,
 * the rollout copy beside it still succeeded, and the remedy is printed. That is a normal outcome,
 * not an error.
 */
function failedNameWrites(report: MigrateHomeReport): number {
    return report.sessionNames.reduce((total, names) => total + names.stateFailed, 0);
}

/**
 * The exit code, set at EVERY door this command can leave through.
 *
 * Written once per report instead of once per branch: the first version of the check sat below
 * the early return that ends an applied or non-interactive run, so `--apply` printed
 * "1 state database(s) refused the write" and still exited 0, and only `--json` and the
 * interactive confirm ever reached it.
 */
function markExitCode(report: MigrateHomeReport): void {
    process.exitCode = report.refusals.length > 0 || failedNameWrites(report) > 0 ? 1 : 0;
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
        const sources = createBoxTable([
            "SOURCE",
            "ROLLOUTS",
            "TO COPY",
            "ALREADY THERE",
            "COLLISIONS",
            "LIVE, SKIPPED",
            "COPIED",
        ]);

        for (const source of report.sources) {
            sources.push([
                source.home,
                String(source.rollouts),
                String(source.toCopy),
                String(source.alreadyPresent),
                source.collisions.length > 0 ? pc.red(String(source.collisions.length)) : "0",
                source.skippedLive.length > 0 ? pc.yellow(String(source.skippedLive.length)) : "0",
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

    for (const source of report.sources) {
        for (const skipped of source.skippedLive) {
            const holders = [...new Set(skipped.holders.map((holder) => `${holder.command}(${holder.pid})`))].join(
                ", "
            );
            out.println(
                `  ${pc.yellow("skipped, held open")} ${skipped.nativeId}\n    ${skipped.path}\n    held by ${holders}; rerun once it is closed`
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

    // A run whose only outcome was "skipped, the database is busy" or "the write failed" used to
    // match none of these and print nothing at all, which reads exactly like "nothing needed
    // naming". Both now keep the section on screen.
    const carried = report.sessionNames.filter(
        (names) => names.added > 0 || names.stateAdded > 0 || names.stateSkippedBusy > 0 || names.stateFailed > 0
    );

    if (carried.length > 0) {
        renderCliSection("Thread names");

        for (const names of carried) {
            // `names.written` answers "did this source's carry write anything", which a run whose
            // only outcome was a busy skip or a refused write answers with `false` — and labelling
            // that "(dry run)" under an "applied" header contradicts the very rows below it. The
            // run's own mode is the honest source for the label.
            const dry = report.applied ? "" : pc.dim(" (dry run)");
            renderCliKeyRow("source", names.home, 18);
            renderCliKeyRow("session index", `${names.added} name(s)${dry}`, 18);
            renderCliKeyRow("codex state", `${names.stateAdded} thread(s) named${dry}`, 18);

            if (names.stateSkippedBusy > 0) {
                renderCliKeyRow(
                    "skipped (busy)",
                    pc.yellow(
                        `${names.stateSkippedBusy} state database(s) a live process holds — close Codex on the destination and rerun; the carry is idempotent`
                    ),
                    18
                );
            }

            if (names.stateFailed > 0) {
                renderCliKeyRow("failed", pc.red(`${names.stateFailed} state database(s) refused the write`), 18);
            }
        }
    }

    if (report.backups.sessions || report.backups.globalState || report.backups.state?.length) {
        renderCliSection("Backups");
        renderCliKeyRow("sessions", report.backups.sessions ?? "—", 14);
        renderCliKeyRow("desktop state", report.backups.globalState ?? "—", 14);

        // The thread-name merge writes into these, and the README sends the reader here for the
        // rollback path. Rendering only the two rows above meant a run whose ONLY backup was a
        // state database printed no Backups section at all.
        for (const path of report.backups.state ?? []) {
            renderCliKeyRow("codex state", path, 14);
        }

        renderCliKeyRow("source", "untouched; the copy never unlinks", 14);
    }

    for (const source of report.sources) {
        if (source.archivedTo) {
            renderCliKeyRow("archived", source.archivedTo, 14);
        }
    }

    if (report.skippedSources.length > 0) {
        renderCliSection("Skipped sources");

        for (const skipped of report.skippedSources) {
            out.println(`  ${pc.yellow("–")} ${skipped.home}: ${skipped.reason}`);
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

/** The prompts this command asks, and the one probe a test must not run for real. */
export interface MigrateHomeInteraction {
    interactive(): boolean;
    confirm(options: { message: string; initialValue: boolean; danger?: boolean }): Promise<boolean>;
    /**
     * Injected by tests. The real probe spawns `lsof`, which takes seconds under a parallel suite
     * and timed the question-order test out at exactly its 5 s budget while passing on its own.
     */
    inspectOpenFiles?: (query: OpenFilesQuery) => OpenFilesResult;
}

const terminalInteraction: MigrateHomeInteraction = {
    interactive: isInteractive,
    confirm: (options) => p.confirm(options),
};

export async function runMigrateHome(
    options: MigrateHomeCliOptions,
    interaction: MigrateHomeInteraction = terminalInteraction
): Promise<void> {
    const destination = expandTilde(options.to ?? join(homedir(), ".codex"));
    const from = homeList(options.from);
    const interactive = interaction.interactive();
    const base: MigrateHomeOptions = {
        from: from.length > 0 ? from : undefined,
        to: destination,
        inspectOpenFiles: interaction.inspectOpenFiles,
    };

    let desktop = options.desktop === true;
    let archiveSource = options.archiveSource === true;
    let apply = options.apply === true;

    if (!apply && !interactive && !options.json) {
        out.log.info(
            `Dry run. ${suggestCommand("tools codex migrate-home", { add: ["--apply"], subcommand: ["migrate-home"] })}`
        );
    }

    if (!options.desktop && interactive && !options.json) {
        desktop = await interaction.confirm({
            message: "Also merge Codex Desktop projects and thread assignments?",
            initialValue: false,
        });
    }

    // Asked BEFORE the plan, like `--desktop` above it. `--archive-source` has refusals of its
    // own (a source a live process holds), and asking after the plan meant those refusals were
    // never evaluated: the user confirmed a copy of N rollouts, said yes to archiving, and the
    // apply run then refused and copied nothing, after two confirmations that promised N.
    if (!options.archiveSource && interactive && !options.json) {
        archiveSource = await interaction.confirm({
            message: "Rename each source sessions/ to sessions.migrated-<stamp> after the copy verifies?",
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
        markExitCode(report);
        return;
    }

    renderReport(report);
    markExitCode(report);

    if (report.refusals.length > 0) {
        return;
    }

    // Copying rollouts is not the only work this command does. Gating on `toCopy` alone meant the
    // ORDINARY second run — rollouts already in the destination, the source having since named
    // them — printed the pending names and then exited without offering to write them. A
    // confirmed `--desktop` merge was stranded the same way.
    const pendingNames = report.sessionNames.reduce((total, names) => total + names.added + names.stateAdded, 0);
    const pendingDesktop = report.desktop.reduce(
        (total, desktop) => total + desktop.projectsAdded.length + desktop.assignmentsAdded,
        0
    );

    if (report.applied || !interactive || (report.totals.toCopy === 0 && pendingNames === 0 && pendingDesktop === 0)) {
        return;
    }

    const work = [
        report.totals.toCopy > 0 ? `copy ${report.totals.toCopy} rollout(s)` : "",
        pendingNames > 0 ? `carry ${pendingNames} name(s)` : "",
        pendingDesktop > 0 ? `merge ${pendingDesktop} desktop entr(ies)` : "",
    ].filter(Boolean);
    const sentence = work.join(", ");
    const proceed = await interaction.confirm({
        message: `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)} into ${report.destination} now?`,
        initialValue: false,
        danger: true,
    });

    if (!proceed) {
        out.log.info("Nothing was written.");
        return;
    }

    apply = true;
    report = await migrateHome({ ...base, apply, desktop, archiveSource });
    renderReport(report);
    log.info({ totals: report.totals, applied: report.applied }, "migrate-home finished");

    // A state database that refused the write leaves `stateAdded` at 0, which is indistinguishable
    // from "nothing needed naming" unless the exit code says otherwise.
    markExitCode(report);
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
        // Commander calls the handler with (options, command), and a bare `runMigrateHome` took
        // that Command as its `interaction`, so every CLI run died on `interaction.interactive`.
        .action((options: MigrateHomeCliOptions) => runMigrateHome(options));
}
