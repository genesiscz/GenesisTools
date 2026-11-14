import { openProject } from "@app/recorder/lib/edit";
import { chapterLines, exportChapterPoints, markersOf } from "@app/recorder/lib/moments";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("markers")
        .description("The moments marked while a recording ran, with where each plays in its edit (null when cut)")
        .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
        .option(
            "--chapters",
            "as \"0:00 Intro\" chapter lines for the exported file's description (cut markers left out; with an intro card the first line is its title and every marker sits the card's length later)"
        )
        .option("--output-time", "with --chapters: the movie's own times, without the intro card")
        .action(async (value: string, flags: { chapters?: boolean; outputTime?: boolean }) => {
            try {
                const opened = await openProject(value);

                if (flags.chapters) {
                    const chapters = exportChapterPoints(opened, { clock: flags.outputTime ? "output" : "export" });
                    out.print(`${chapterLines(chapters).join("\n")}\n`);
                    return;
                }

                out.result(markersOf(opened));
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
