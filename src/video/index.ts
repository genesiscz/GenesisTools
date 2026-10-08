import { resolve } from "node:path";
import { runTool, suggestEnumFlag } from "@genesiscz/utils/cli";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { out } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { prepareVideoEvidence } from "@genesiscz/utils/video/evidence";
import { probeVideo } from "@genesiscz/utils/video/probe";
import { VIDEO_FPS, VIDEO_GROUPS, videoSettingsSchema } from "@genesiscz/utils/video/types";
import { Command } from "commander";

export function registerVideoCommands(program: Command): void {
    program
        .command("probe <input>")
        .description("Inspect a local video, including silent videos")
        .option("--json", "Print structured metadata")
        .action(async (input: string) => {
            await withInterrupt(async (signal) => out.result(await probeVideo({ input, signal })), {
                handleTermination: true,
            });
        });
    program
        .command("frames <input>")
        .description("Prepare timestamped PNG contact sheets and full-resolution frames")
        .option("--fps [value]", "Frames per second: 1, 2, 3, 4", "2")
        .option("--frames-per-image [value]", "Frames per PNG: 1, 4, 8, 16, 32", "16")
        .option("--difference <percent>", "Skip samples below this changed-pixel percentage", "0")
        .option("--out <directory>", "Output root, with a new immutable generation per run")
        .option("--json", "Print the generation manifest")
        .action(
            async (
                input: string,
                options: { fps: string | boolean; framesPerImage: string | boolean; difference: string; out?: string }
            ) => {
                for (const [flag, value, allowed] of [
                    ["--fps", options.fps, VIDEO_FPS],
                    ["--frames-per-image", options.framesPerImage, VIDEO_GROUPS],
                ] as const) {
                    if (typeof value !== "string" || !allowed.some((number) => number === Number(value))) {
                        out.log.error(suggestEnumFlag("tools video frames", flag, allowed.map(String)));
                        process.exitCode = 1;
                        return;
                    }
                }

                const parsed = videoSettingsSchema.safeParse({
                    fps: Number(options.fps),
                    framesPerImage: Number(options.framesPerImage),
                    minimumDifferencePct: Number(options.difference),
                });
                if (!parsed.success) {
                    out.log.error(`--difference must be a percentage between 0 and 100 (got "${options.difference}")`);
                    process.exitCode = 1;
                    return;
                }
                const settings = parsed.data;
                await withInterrupt(
                    async (signal) => {
                        const manifest = await prepareVideoEvidence({
                            input,
                            settings,
                            signal,
                            outputRoot: options.out ? resolve(options.out) : toolDataDir("video", "evidence"),
                        });
                        out.result(manifest);
                    },
                    { handleTermination: true }
                );
            }
        );
}

if (import.meta.main) {
    const program = new Command().name("video").description("Local video inspection and evidence preparation");
    registerVideoCommands(program);
    await runTool(program, { tool: "video" });
}
