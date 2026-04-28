import { registerServerInstall } from "@app/youtube/lib/server/cli/install";
import { registerServerStart } from "@app/youtube/lib/server/cli/start";
import { registerServerStatus } from "@app/youtube/lib/server/cli/status";
import { registerServerStop } from "@app/youtube/lib/server/cli/stop";
import type { Command } from "commander";

export function registerServerCommand(program: Command): void {
    const cmd = program.command("server").description("Run the YouTube API server (HTTP + WebSocket)");
    registerServerStart(cmd);
    registerServerStop(cmd);
    registerServerStatus(cmd);
    registerServerInstall(cmd);
}
