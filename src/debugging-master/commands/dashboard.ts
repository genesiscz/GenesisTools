import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { out } from "@app/logger";
import { getLocalIpv4 } from "@app/utils/network";
import { renderQr } from "@app/utils/qr";
import type { Command } from "commander";
import pc from "picocolors";

const DASHBOARD_ROOT = resolve(import.meta.dir, "..", "dashboard");

export function registerDashboardCommand(program: Command): void {
    const dashboard = program.command("dashboard").description("Build or open the live log dashboard");

    dashboard
        .command("build")
        .description("Compile the dashboard frontend (vite build)")
        .action(async () => {
            await runBuild();
        });

    dashboard
        .command("open")
        .description("Print the dashboard URL + QR and open it in the browser")
        .option("--port <n>", "Port the ingest server is on", "7243")
        .action(async (opts: { port: string }) => {
            const port = Number.parseInt(opts.port, 10);
            const lanIp = getLocalIpv4();
            const url = `http://${lanIp}:${port}/`;

            out.println("");
            out.println(`  ${pc.bold(pc.yellow("dashboard:"))} ${pc.bold(url)}`);
            out.println("");
            out.println(pc.dim("  scan from your phone:"));
            out.println(renderQr(url, { small: true }));

            try {
                const cmd = openCommand(url);
                await Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }).exited;
            } catch {
                // open command not available — silently skip
            }
        });
}

/** Browser-open command per platform. macOS: `open`, Linux: `xdg-open`, Windows: `cmd /c start ""`. */
function openCommand(url: string): string[] {
    switch (process.platform) {
        case "darwin":
            return ["open", url];
        case "win32":
            // Empty "" arg is the window title — required by `start` so the
            // URL isn't misinterpreted as a title when it contains spaces.
            return ["cmd", "/c", "start", "", url];
        default:
            return ["xdg-open", url];
    }
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
