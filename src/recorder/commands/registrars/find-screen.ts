import { statSync } from "node:fs";
import { openProject } from "@app/recorder/lib/edit";
import { findOnScreenOf } from "@app/recorder/lib/fx-analysis";
import { resolveRecording } from "@app/recorder/lib/library";
import { screenHitsWithOps } from "@app/recorder/lib/screen-ops";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

const { log } = logger.scoped("recorder");

/** The source length of a recording's movie in seconds, to keep the hits' ops inside it; undefined without a movie. */
async function movieSeconds(folder: string): Promise<number | undefined> {
    try {
        return (await openProject(folder)).project.source.durationUs / 1_000_000;
    } catch (error) {
        log.debug({ error, folder }, "find-screen: no movie, so the ops keep the frames' own ends");
        return undefined;
    }
}

export function register(program: Command): void {
    program
        .command("find-screen")
        .description(
            "Where a text was on the screen, at source seconds: a frames recording or a meeting from its OCR, a movie from its screen text (the first search reads it once, which can take minutes)"
        )
        .argument("<recording>", "a library id, `last`, a meeting id or a recording folder")
        .argument("<text>", "the text to look for (case and accents ignored)")
        .option("--limit <n>", "at most this many frames", "50")
        .option("--json", "print JSON")
        .action(async (value: string, text: string, flags: { limit?: string; json?: boolean }) => {
            try {
                const folder = resolveRecording(value);
                // A standalone movie has no recording.json: it goes to the movie's own screen-text path.
                const recordingFolder = statSync(folder).isDirectory() ? folder : undefined;
                const hits = await findOnScreenOf(
                    recordingFolder,
                    async () => (await openProject(folder)).project,
                    text,
                    {
                        limit: Number(flags.limit ?? 50),
                    }
                );

                if (flags.json) {
                    out.result(screenHitsWithOps(hits, await movieSeconds(folder)));
                    return;
                }

                for (const hit of hits) {
                    const clock = new Date(hit.sec * 1000).toISOString().slice(11, 19);
                    out.println(
                        `${clock}  d${hit.displayId ?? "?"}${hit.shown ? "" : " (not the shown display)"}  ${hit.lines.join(" | ")}`
                    );
                }

                if (hits.length === 0) {
                    out.printlnErr(`No frame shows "${text}".`);
                }
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
