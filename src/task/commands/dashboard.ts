import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runBuild as runDbgDashboardBuild } from "@app/debugging-master/commands/dashboard";
import { out } from "@app/logger";
import { getLocalIpv4 } from "@app/utils/network";
import { renderQr } from "@app/utils/qr";
import type { Command } from "commander";
import pc from "picocolors";

const DASHBOARD_ROOT = resolve(import.meta.dir, "..", "..", "debugging-master", "dashboard");

export function registerDashboardCommand(program: Command): void {
    const dashboard = program.command("dashboard").description("Build or open the unified log dashboard");

    dashboard
        .command("build")
        .description("Compile the dashboard frontend")
        .action(async () => {
            await runDbgDashboardBuild();
        });

    dashboard
        .command("open")
        .description("Print dashboard URL and open in browser")
        .option("--port <n>", "Port the dashboard server is on", "7243")
        .option("--session <name>", "Session to deep-link (optional)")
        .action(async (opts: { port: string; session?: string }) => {
            const port = Number.parseInt(opts.port, 10);
            const lanIp = getLocalIpv4();
            let url = `http://${lanIp}:${port}/`;

            if (opts.session) {
                url += `?source=task&session=${encodeURIComponent(opts.session)}`;
            }

            out.log.info("");
            out.log.info(`  ${pc.bold(pc.yellow("dashboard:"))} ${pc.bold(url)}`);
            out.log.info("");
            out.log.info(pc.dim("  scan from your phone:"));
            out.log.info(renderQr(url, { small: true }));

            try {
                const cmd = openCommand(url);
                await Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }).exited;
            } catch {
                // open command not available
            }
        });
}

function openCommand(url: string): string[] {
    switch (process.platform) {
        case "darwin":
            return ["open", url];
        case "win32":
            return ["cmd", "/c", "start", "", url];
        default:
            return ["xdg-open", url];
    }
}

export async function ensureTaskDashboardBuilt(): Promise<void> {
    const distIndex = resolve(DASHBOARD_ROOT, "dist", "index.html");
    if (existsSync(distIndex)) {
        return;
    }

    out.log.info(pc.dim("▸ Dashboard dist/ missing — building once..."));
    await runDbgDashboardBuild();
}
