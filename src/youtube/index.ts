import { enhanceHelp } from "@app/utils/cli/executor";
import { registerAnalyzeCommand } from "@app/youtube/commands/analyze";
import { registerCacheCommand } from "@app/youtube/commands/cache";
import { registerChannelsCommand } from "@app/youtube/commands/channels";
import { registerDownloadCommand } from "@app/youtube/commands/download";
import { registerExtensionCommand } from "@app/youtube/commands/extension";
import { registerPipelineCommand } from "@app/youtube/commands/pipeline";
import { registerServerCommand } from "@app/youtube/commands/server";
import { registerTranscribeCommand } from "@app/youtube/commands/transcribe";
import { registerUiCommand } from "@app/youtube/commands/ui";
import { registerVideosCommand } from "@app/youtube/commands/videos";
import { Command } from "commander";

export function buildYoutubeProgram(): Command {
    const program = new Command()
        .name("youtube")
        .description("YouTube tools — channels, videos, transcripts, summarisation, Q&A")
        .version("2.0.0")
        .option("--json", "Emit structured JSON instead of human output")
        .option("--clipboard", "Copy output to clipboard instead of stdout")
        .option("--silent", "Suppress non-essential logs")
        .option("--verbose", "Enable verbose logs");

    registerChannelsCommand(program);
    registerVideosCommand(program);
    registerTranscribeCommand(program);
    registerDownloadCommand(program);
    registerExtensionCommand(program);
    registerPipelineCommand(program);
    registerAnalyzeCommand(program);
    registerCacheCommand(program);
    registerServerCommand(program);
    registerUiCommand(program);

    enhanceHelp(program);

    return program;
}

const program = buildYoutubeProgram();

program.parseAsync(process.argv).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
