import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBuild as runDbgDashboardBuild } from "@app/debugging-master/commands/dashboard";
import { logDashboardApp } from "@app/debugging-master/lib/log-dashboard-app";
import { out } from "@app/logger";
import { dashboardUrlWithQuery } from "@app/utils/DashboardApp/lifecycle";
import type { Command } from "commander";
import pc from "picocolors";

const DASHBOARD_ROOT = fileURLToPath(new URL("../../debugging-master/dashboard", import.meta.url));

export function registerDashboardCommand(program: Command): void {
    const dashboard = program.command("dashboard").description("Build or open the unified log dashboard");

    dashboard
        .command("build")
        .description("Compile the dashboard frontend")
        .action(async () => {
            await runDbgDashboardBuild();
        });

    dashboard.addCommand(logDashboardApp.commanderCommand);

    dashboard
        .command("open")
        .description("Ensure the log server is up, print URL + QR, and open in the browser")
        .option("--port <n>", "Port the dashboard server is on", String(logDashboardApp.port))
        .option("--no-qr", "Skip the phone-scan QR code")
        .action(async (opts: { port: string; qr?: boolean }) => {
            const port = Number.parseInt(opts.port, 10);
            const globalOpts = program.opts<{ session?: string }>();
            const session = globalOpts.session;
            const query = session ? { source: "task" as const, session } : undefined;

            await logDashboardApp.open({
                port,
                qr: opts.qr === false ? false : undefined,
                query,
            });

            if (query) {
                const url = dashboardUrlWithQuery(logDashboardApp.config, port, query);
                out.print(`${url}\n`);
                out.printlnErr(`  deep-link: ${url}`);
            }
        });
}

export async function ensureTaskDashboardBuilt(): Promise<void> {
    const distIndex = join(DASHBOARD_ROOT, "dist", "index.html");
    if (existsSync(distIndex)) {
        return;
    }

    out.printlnErr(pc.dim("▸ Dashboard dist/ missing — building once..."));
    await runDbgDashboardBuild();
}
