import { youtubeServerApp } from "@app/youtube/lib/server/app";
import type { Command } from "commander";

export function registerServerCommand(program: Command): void {
    program.addCommand(youtubeServerApp.commanderCommand);
}
