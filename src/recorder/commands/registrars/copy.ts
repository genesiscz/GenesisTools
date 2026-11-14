import { ensureRecorderPart, resolveRecording } from "@app/recorder/lib/library";
import { copyRecording } from "@app/recorder/lib/quick-actions";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("copy")
        .description(
            "Copy a recording's movie (the newest export, else its own movie) to the clipboard as a file; --gif copies a GIF of the edit, exporting one when none is current"
        )
        .argument("<recording>", "a library id, `last` or a recording folder")
        .option("--gif", "a GIF of the edit instead of the movie")
        .action(async (value: string, flags: { gif?: boolean }) => {
            try {
                await ensureRecorderPart((line) => out.printlnErr(line));
                out.result(await copyRecording(resolveRecording(value), { gif: flags.gif }));
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
