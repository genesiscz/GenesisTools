import { resolveRecording } from "@app/recorder/lib/library";
import { out } from "@genesiscz/utils/logger";
import { renameRecording } from "@genesiscz/utils/screen-recorder/library";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("rename")
        .description("Give a recording a new title (the library, the editor window and movies.list() show it)")
        .argument("<recording>", "a library id, `last` or a recording folder")
        .argument("<title>", "the new title (1 to 120 characters)")
        .action((value: string, title: string) => {
            try {
                const manifest = renameRecording(resolveRecording(value), title);
                out.result({ id: manifest.id, title: manifest.title });
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
