import { recordingMovie } from "@app/recorder/lib/toolset";
import { out } from "@genesiscz/utils/logger";
import { FILLER_WORDS } from "@genesiscz/utils/recording-editor/transcript-cuts";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("cut-fillers")
        .description(
            `Cut every filler word of the transcript in one step (${Object.keys(FILLER_WORDS).join(", ")} lists, or --words); one undo`
        )
        .argument("<recording>", "a library id, `last`, a meeting id, a recording folder, a movie or an edit.json")
        .option(
            "--lang <code>",
            `the filler list: ${Object.entries(FILLER_WORDS)
                .map(([code, list]) => `${code} (${list.sounds.join(", ")}; with --all also ${list.words.join(", ")})`)
                .join("; ")}; default every language`
        )
        .option("--all", "also the fillers that are real words (jako, like): check with --dry-run first")
        .option("--words <list>", "your own filler words, comma-separated")
        .option("--pad-ms <ms>", "kept off each cut's edges", "40")
        .option("--dry-run", "list what it would cut, save nothing")
        .action(
            async (
                value: string,
                flags: { lang?: string; all?: boolean; words?: string; padMs?: string; dryRun?: boolean }
            ) => {
                try {
                    const answer = await recordingMovie(value).cutFillers({
                        ...(flags.lang ? { language: flags.lang } : {}),
                        level: flags.all ? "all" : "sounds",
                        ...(flags.words ? { words: flags.words.split(",").map((word) => word.trim()) } : {}),
                        padMs: Number(flags.padMs ?? 40),
                        dryRun: flags.dryRun,
                    });
                    out.result(answer);
                } catch (error) {
                    out.printlnErr(error instanceof Error ? error.message : String(error));
                    process.exitCode = 1;
                }
            }
        );
}
