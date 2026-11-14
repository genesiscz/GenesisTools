import { recordingMovie } from "@app/recorder/lib/toolset";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("transcribe")
        .description(
            "Transcribe what the export plays (every unmuted audio track, on the movie's clock) into the transcript the captions read; a paid run, cached beside the movie"
        )
        .argument("<recording>", "a library id, `last`, a meeting id, a recording folder, a movie or an edit.json")
        .option("--provider <provider>", "the transcription provider (default: the configured one)")
        .option("--lang <code>", "the spoken language, e.g. en or cs")
        .option("--refresh", "transcribe again even when a transcript is cached")
        .action(async (value: string, flags: { provider?: string; lang?: string; refresh?: boolean }) => {
            try {
                out.result(
                    await recordingMovie(value).transcript({
                        provider: flags.provider,
                        lang: flags.lang,
                        refresh: flags.refresh,
                    })
                );
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
