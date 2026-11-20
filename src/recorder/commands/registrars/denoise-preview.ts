import { parseTime } from "@app/recorder/commands/registrars/parse";
import { Movie } from "@app/recorder/lib/toolset";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("denoise-preview")
        .description(
            "Five seconds of the recording's sound from a SOURCE time, cleaned with the edit's noise reduction as the export cleans it, as one .m4a beside the movie (the editor's Preview button plays it)"
        )
        .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
        .option("--at <time>", "where the preview starts: SOURCE seconds or m:ss (default 0)")
        .option("--seconds <n>", "how long it plays, 1–30 (default 5)")
        .action(async (value: string, flags: { at?: string; seconds?: string }) => {
            try {
                const seconds = flags.seconds === undefined ? undefined : Number(flags.seconds);

                if (seconds !== undefined && !(Number.isFinite(seconds) && seconds >= 1 && seconds <= 30)) {
                    throw new Error(`--seconds must be a number from 1 to 30, not "${flags.seconds}"`);
                }

                const at = flags.at === undefined ? 0 : parseTime(flags.at, "--at");
                out.result(await new Movie(value).denoisePreview(at, seconds));
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
