import { runBuild as runDbgDashboardBuild } from "@app/debugging-master/commands/dashboard";
import { logDashboardApp } from "@app/debugging-master/lib/log-dashboard-app";
import { out } from "@app/logger";
import { dashboardUrlWithQuery } from "@app/utils/DashboardApp/lifecycle";
import { TaskSessionStore } from "@app/task/lib/session-store";
import type { Command } from "commander";

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
        .option("--session <name>", "Session name (fuzzy-matched; inherits global if unset)")
        .option("--port <n>", "Port the dashboard server is on", String(logDashboardApp.port))
        .option("--no-qr", "Skip the phone-scan QR code")
        .action(async (opts: { port: string; qr?: boolean; session?: string }) => {
            const port = Number.parseInt(opts.port, 10);
            const globalOpts = program.opts<{ session?: string }>();
            // Fuzzy-resolve via the session store so prefix/abbrev matches
            // work (e.g. --session metro resolves to the latest
            // metro-2026-05-26_14-30-22). Without this the deep-link query
            // is passed through verbatim and a 404 lands on App.refreshSessions
            // which falls back to the first session in the list — silently
            // opening a different one than the user typed.
            const rawSession = opts.session ?? globalOpts.session;
            let session: string | undefined;
            if (rawSession) {
                try {
                    session = await new TaskSessionStore().resolveSession(rawSession);
                } catch (err) {
                    const detail = err instanceof Error ? err.message : String(err);
                    out.printlnErr(`error: --session "${rawSession}" did not resolve: ${detail}`);
                    await out.flush();
                    process.exit(1);
                }
            }

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
