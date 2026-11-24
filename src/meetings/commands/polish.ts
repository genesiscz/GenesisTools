import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { colorizeUnifiedDiff } from "@genesiscz/utils/diff";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { initPolished } from "../lib/polish/adopt";
import { buildPolished, type PolishBuildResult, PolishedModuleUnlinkedError } from "../lib/polish/build";
import { fail } from "../lib/shared";

/** The diff lines `--check` prints; a first build over a hand-written file differs on thousands of lines. */
const DIFF_LINES_SHOWN = 80;

/** A verdict that fails `--check`: the file is behind its sources, edited by hand, missing or from a newer build. */
function checkFails(result: PolishBuildResult): boolean {
    const verdict = result.check?.verdict;
    return (
        result.check?.exists === false || verdict === "stale" || verdict === "hand-edited" || verdict === "unsupported"
    );
}

/** Why the module's `@genesiscz/utils` import does not resolve, and the command that names the fix for that folder. */
function reportUnlinked(dir: string, severity: "warn" | "error"): void {
    out.log[severity](`@genesiscz/utils does not resolve from ${dir} yet, so the .polished.ts cannot load.`);
    out.log.info(
        `${toolCommand("link", "status", "--root", dir)} names the cause and the one install command that fixes it.`
    );
}

function report(result: PolishBuildResult): void {
    for (const warning of result.warnings) {
        out.log.warn(warning);
    }

    const parts = result.parts
        .map((part) => `${part.record}: ${part.lines} lines, ${part.terms} terms, ${part.questions} open questions`)
        .join("; ");

    if (result.mode === "check") {
        const verdict = result.check?.exists === false ? "missing" : (result.check?.verdict ?? "missing");
        const line = `${result.outPath}: ${verdict}. ${result.check?.message ?? ""}`;

        if (checkFails(result)) {
            out.log.error(line);
        } else {
            out.log.success(line);
        }

        if (result.check?.diff) {
            const lines = result.check.diff.split("\n");
            out.println(colorizeUnifiedDiff(lines.slice(0, DIFF_LINES_SHOWN).join("\n")));

            if (lines.length > DIFF_LINES_SHOWN) {
                out.log.info(`… ${lines.length - DIFF_LINES_SHOWN} more diff lines; --json carries the whole diff.`);
            }
        }

        return;
    }

    if (result.outcome === "refused") {
        out.log.error(`${result.outPath}: ${result.check?.message ?? "refused"} Refusing to overwrite it.`);
        out.log.info(
            "Move the hand edit into the .polished.ts (a section's md, an override, a phrase), then build again."
        );
        out.log.info(`It was a mistake: ${toolCommand("meetings polish build", result.file, "--force")}`);
        return;
    }

    const did = {
        written: "written",
        "would-write": "would be written (dry run)",
        unchanged: "is already up to date",
        refused: "refused",
    }[result.outcome ?? "unchanged"];
    out.log.success(`${result.outPath} ${did}. ${parts}`);

    if (result.carried.length > 0) {
        out.log.info(`Kept front matter the build does not write: ${result.carried.join(", ")}.`);
    }
}

export function registerPolishCommands(program: Command): void {
    const polish = program
        .command("polish")
        .description("The polished meeting file: build it from its .polished.ts and the live records");

    polish
        .command("build")
        .argument("<file>", "the meeting's .polished.ts (export default defineMeetingsPolished({ … }))")
        .description(
            "Write the polished markdown from the .polished.ts and the records: transcripts with suggestions applied, speaker and term diffs, lines per person, open questions"
        )
        .option(
            "--check",
            "write nothing; report clean, stale, hand-edited or missing, with the diff (exit 1 unless clean)"
        )
        .option("--dry-run", "render and compare, write nothing")
        .option("--force", "overwrite the markdown even when it was edited by hand")
        .option("--json", "print the result as JSON")
        .action(async (file: string, opts: { check?: boolean; dryRun?: boolean; force?: boolean; json?: boolean }) => {
            try {
                const result = await buildPolished({
                    file,
                    mode: opts.check ? "check" : opts.dryRun ? "dry-run" : "write",
                    force: opts.force,
                });

                if (opts.json) {
                    out.result(SafeJSON.stringify(result, null, 2));
                } else {
                    report(result);
                }

                if (result.outcome === "refused" || (result.mode === "check" && checkFails(result))) {
                    process.exitCode = 1;
                }
            } catch (error) {
                if (error instanceof PolishedModuleUnlinkedError) {
                    reportUnlinked(error.dir, "error");
                    process.exitCode = 1;
                    return;
                }

                fail(error);
            }
        });

    polish
        .command("init")
        .description("Write a NEW .polished.ts from a draft polished JSON, once; every draft field is kept or reported")
        .requiredOption("--from <json>", "the draft, e.g. <name>.polished.json")
        .option("--out <file>", "the .polished.ts to write (default: the draft's path with .ts)")
        .option("--json", "print the result as JSON")
        .action(async (opts: { from: string; out?: string; json?: boolean }) => {
            try {
                const result = await initPolished({ from: opts.from, ...(opts.out ? { out: opts.out } : {}) });

                if (opts.json) {
                    out.result(SafeJSON.stringify(result, null, 2));
                } else {
                    out.log.success(`Created ${result.path}.`);
                    out.log.info(`Mapped: ${result.report.mapped.join(", ") || "nothing"}.`);

                    if (result.report.kept.length > 0) {
                        out.log.warn(`Kept under extras, not rendered: ${result.report.kept.join(", ")}.`);
                    }

                    for (const note of result.report.notes) {
                        out.log.info(note);
                    }
                }

                if (result.unlinkedDir) {
                    reportUnlinked(result.unlinkedDir, "warn");
                }

                out.log.info(`Then: ${toolCommand("meetings polish build", result.path)}`);
            } catch (error) {
                fail(error);
            }
        });
}
