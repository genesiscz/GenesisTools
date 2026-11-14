import { statSync } from "node:fs";
import { dirname } from "node:path";
import { libraryRow, resolveRecording } from "@app/recorder/lib/library";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("show")
        .alias("info")
        .description(
            "One recording's facts as JSON, as a row of list --json: its id, title, folder, start, length, how it ended, frames, movie and whether it was edited"
        )
        .argument("<recording>", "a library id (short or whole), `last`, `open`, a recording folder or a movie")
        .action((value: string) => {
            try {
                const path = resolveRecording(value);
                const folder = statSync(path).isDirectory() ? path : dirname(path);
                const row = libraryRow(folder);

                if (!row) {
                    throw new Error(`${folder} holds no readable recording.json`);
                }

                out.result(row);
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
