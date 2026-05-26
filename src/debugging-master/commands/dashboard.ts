import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { logDashboardApp } from "@app/debugging-master/lib/log-dashboard-app";
import { logDashboardUiApp } from "@app/debugging-master/lib/log-dashboard-ui-app";
import { out } from "@app/logger";
import type { Command } from "commander";
import pc from "picocolors";

const DASHBOARD_ROOT = resolve(import.meta.dir, "..", "dashboard");

export function registerDashboardCommand(program: Command): void {
    const dashboard = program.command("dashboard").description("Build or open the live log dashboard");

    dashboard
        .command("build")
        .description("Compile the dashboard frontend (vite build) — required for `serve`, not for `ui` dev")
        .action(async () => {
            await runBuild();
        });

    dashboard.addCommand(logDashboardApp.commanderCommand);
    dashboard.addCommand(logDashboardUiApp.commanderCommand);
}

export async function runBuild(): Promise<void> {
    if (!existsSync(resolve(DASHBOARD_ROOT, "vite.config.ts"))) {
        out.error(pc.red(`✗ Dashboard source not found at ${DASHBOARD_ROOT}`));
        process.exit(1);
    }

    out.println(pc.dim(`▸ Building dashboard at ${DASHBOARD_ROOT}`));

    const proc = Bun.spawn(["bunx", "vite", "build", "--logLevel", "warn"], {
        cwd: DASHBOARD_ROOT,
        stdout: "inherit",
        stderr: "inherit",
    });
    const code = await proc.exited;
    if (code !== 0) {
        out.error(pc.red(`✗ Build failed (exit ${code})`));
        process.exit(code);
    }

    out.println(pc.green("✓ Dashboard built"));
}

/** Used at server startup if dist/ is missing — auto-builds once so users don't see a 503. */
export async function ensureDashboardBuilt(): Promise<void> {
    const distIndex = resolve(DASHBOARD_ROOT, "dist", "index.html");
    if (existsSync(distIndex)) {
        return;
    }
    out.println(pc.dim("▸ Dashboard dist/ missing — building once..."));
    await runBuild();
}
