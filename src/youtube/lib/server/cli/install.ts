import { installLaunchd, isLaunchdInstalled } from "@app/youtube/lib/server/launchd";
import * as p from "@clack/prompts";
import type { Command } from "commander";

interface InstallOpts {
    port?: number;
}

export function registerServerInstall(parent: Command): void {
    parent
        .command("install")
        .description("Install server as a launchd agent (macOS) — runs at login")
        .option("--port <n>", "Port to expose (default 9876)", (value) => Number.parseInt(value, 10))
        .addHelpText(
            "after",
            "\nExamples:\n  $ tools youtube server install\n  $ tools youtube server install --port 9999\n"
        )
        .action(async (opts: InstallOpts) => {
            if (process.platform !== "darwin") {
                p.log.error("server install is only supported on macOS (launchd).");
                process.exitCode = 1;
                return;
            }

            if (isLaunchdInstalled()) {
                p.log.info("Server is already installed in launchd.");
                return;
            }

            await installLaunchd({ port: opts.port ?? 9876 });
            p.log.success(
                `Installed launchd agent on port ${opts.port ?? 9876}. Run \`tools youtube server status\` to verify.`
            );
        });
}
