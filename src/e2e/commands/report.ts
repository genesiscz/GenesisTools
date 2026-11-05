import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ui } from "@genesiscz/utils/cli/ui";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { listRunDirs, runsRoot } from "../lib/paths";
import { loadProject, type ProjectOptions, withConfig } from "../lib/project";
import { compareRuns, formatSummary, readSummary } from "../lib/summary";

/** A run folder from what a person types: a path, a stamp under the project's runs, `latest`, or `previous`. */
async function runDirOf(options: ProjectOptions, run: string | undefined): Promise<string> {
    if (run && (isAbsolute(run) || run.includes("/")) && existsSync(run)) {
        return resolve(run);
    }

    const project = await loadProject(options);
    const runs = listRunDirs(project.config.id);
    const pick =
        run === undefined || run === "latest"
            ? runs[0]
            : run === "previous"
              ? runs[1]
              : join(runsRoot(project.config.id), run);

    if (!pick || !existsSync(pick)) {
        throw new Error(`no run ${run ?? "latest"} for ${project.config.id} under ${runsRoot(project.config.id)}`);
    }

    return pick;
}

export function registerReport(program: Command): void {
    withConfig(
        program
            .command("report [run]")
            .description("Print a run's summary: a run folder, a stamp, latest (the default) or previous")
    )
        .option("--json", "print summary.json")
        .action(async (run: string | undefined, options: ProjectOptions & { json?: boolean }) => {
            const dir = await runDirOf(options, run);
            const summary = readSummary(dir);

            if (!summary.ok) {
                process.exitCode = 1;
            }

            if (options.json) {
                out.result(summary);
                return;
            }

            const markdown = join(dir, "summary.md");
            out.print(existsSync(markdown) ? readFileSync(markdown, "utf8") : formatSummary(summary));

            if (!summary.ok) {
                process.exitCode = 1;
            }
        });

    withConfig(
        program
            .command("compare [before] [after]")
            .description("Name every test whose state changed between two runs (default: previous and latest)")
    )
        .option("--json", "print the changes as JSON")
        .action(
            async (
                before: string | undefined,
                after: string | undefined,
                options: ProjectOptions & { json?: boolean }
            ) => {
                const older = readSummary(await runDirOf(options, before ?? "previous"));
                const newer = readSummary(await runDirOf(options, after ?? "latest"));
                const changes = compareRuns(older, newer);

                if (changes.some((change) => change.after === "failed")) {
                    process.exitCode = 1;
                }

                if (options.json) {
                    out.result({ before: older.runDir, after: newer.runDir, changes });
                    return;
                }

                ui.info(`${older.runDir} → ${newer.runDir}`);

                if (changes.length === 0) {
                    ui.ok("no test changed state");
                }

                for (const change of changes) {
                    const line = `${change.test}: ${change.before} → ${change.after}`;
                    change.after === "failed" ? ui.err(line) : ui.dim(line);
                }

                if (changes.some((change) => change.after === "failed")) {
                    process.exitCode = 1;
                }
            }
        );
}
