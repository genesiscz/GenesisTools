import { importMovie, parseImportMarker } from "@app/recorder/lib/import";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { formatCount } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("import")
        .description(
            "Make a library recording of a movie file (.mp4, .m4v or .mov), titled --title or the file's name, with a marker at each --marker: an APFS clone of it where the disk can make one (no extra disk), else a whole copy, and the file stays as it is; prints its folder, and the editor, movies.open() and every command take its id"
        )
        .argument("<movie>", "the movie file")
        .option("--title <title>", "the library's title (1 to 120 characters); default the file's name")
        .option(
            "--marker <time=label>",
            "a marker at a time of the movie (seconds or m:ss): 0:12=Login done; repeat it for more",
            (value: string, previous: string[]) => [...previous, value],
            [] as string[]
        )
        .option("--json", "print the whole answer as JSON")
        .action(async (movie: string, flags: { title?: string; marker: string[]; json?: boolean }) => {
            try {
                const answer = await importMovie(movie, {
                    title: flags.title,
                    markers: flags.marker.map(parseImportMarker),
                });

                if (flags.json) {
                    out.result(answer);
                    return;
                }

                const sound = answer.audioTracks > 0 ? "with its sound" : "no sound";
                out.println(answer.folder);
                out.printlnErr(
                    `"${answer.title}" is ${answer.id} in the library: ${answer.seconds} s, ${sound}, ${formatCount(answer.markers.length, "marker")}. ${toolCommand("recorder edit", answer.id)} opens it in the editor.`
                );
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
