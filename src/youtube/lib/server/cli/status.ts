import { renderOrEmit } from "@app/youtube/commands/_shared/render";
import { readPid } from "@app/youtube/lib/server/daemon";
import { isLaunchdInstalled } from "@app/youtube/lib/server/launchd";
import { readPortFile } from "@app/youtube/lib/server/port-file";
import type { Command } from "commander";
import pc from "picocolors";

export function registerServerStatus(parent: Command): void {
    parent
        .command("status")
        .description("Show server status (PID, port, launchd state)")
        .action(async (_: unknown, cmd: Command) => {
            const pid = readPid();
            const port = readPortFile();
            const launchd = isLaunchdInstalled();

            const lines: string[] = [];
            lines.push(pid ? pc.green(`running · PID ${pid}`) : pc.dim("not running"));
            lines.push(port !== null ? `port: ${port}` : pc.dim("port: —"));
            lines.push(launchd ? pc.green("launchd: installed") : pc.dim("launchd: not installed"));

            await renderOrEmit({
                text: lines.join("\n"),
                json: { running: pid !== null, pid, port, launchdInstalled: launchd },
                flags: cmd.optsWithGlobals(),
            });
        });
}
