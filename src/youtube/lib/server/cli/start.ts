import { startServer } from "@app/youtube/lib/server";
import { readPid } from "@app/youtube/lib/server/daemon";
import { installLaunchd, isLaunchdInstalled } from "@app/youtube/lib/server/launchd";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

interface StartOpts {
    port?: number;
    background?: boolean;
}

export function registerServerStart(parent: Command): void {
    parent
        .command("start")
        .description("Start the YouTube API server (foreground by default)")
        .option("--port <n>", "Port (defaults to apiPort from server.json or 9876)", (value) =>
            Number.parseInt(value, 10)
        )
        .option("--background", "Daemonise via launchd (macOS only)")
        .addHelpText(
            "after",
            "\nExamples:\n  $ tools youtube server start\n  $ tools youtube server start --port 9999\n  $ tools youtube server start --background\n"
        )
        .action(async (opts: StartOpts) => {
            const existing = readPid();

            if (existing) {
                p.log.warn(`Server already running (PID ${existing}). Run \`tools youtube server stop\` first.`);
                process.exitCode = 1;
                return;
            }

            if (opts.background) {
                if (process.platform !== "darwin") {
                    p.log.error("--background is only supported on macOS (launchd).");
                    process.exitCode = 1;
                    return;
                }

                if (isLaunchdInstalled()) {
                    p.log.info("Server is already installed in launchd.");
                    return;
                }

                await installLaunchd({ port: opts.port ?? 9876 });
                p.log.success(
                    `Installed launchd agent on port ${opts.port ?? 9876}. Use \`tools youtube server stop --uninstall\` to remove.`
                );
                return;
            }

            const handle = await startServer({ port: opts.port, daemon: true });
            p.log.success(`Server listening on http://localhost:${handle.port} ${pc.dim("(Ctrl+C to stop)")}`);
            await new Promise(() => undefined);
        });
}
