#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "@app/logger";
import { runTool } from "@app/utils/cli";
import { defineDashboardApp } from "@app/utils/DashboardApp";
import { Command } from "commander";
import pc from "picocolors";

const DASHBOARD_DIR = dirname(fileURLToPath(import.meta.url));
const NODE_MODULES = join(DASHBOARD_DIR, "node_modules");
const DEFAULT_PORT = 3000;

function runToCompletion(cmd: string, args: string[]): Promise<number> {
    const child = spawn(cmd, args, { cwd: DASHBOARD_DIR, stdio: "inherit" });
    return new Promise((res) => child.on("exit", (code) => res(code ?? 1)));
}

async function nativeDepsHealthy(): Promise<boolean> {
    const sqlitePath = join(NODE_MODULES, "better-sqlite3");
    if (!existsSync(sqlitePath)) {
        return true;
    }

    const proc = Bun.spawn(["sh", "-lc", "cd apps/web && node -e \"require('better-sqlite3')(':memory:').close()\""], {
        cwd: DASHBOARD_DIR,
        stdout: "ignore",
        stderr: "pipe",
    });
    const code = await proc.exited;

    return code === 0;
}

async function rebuildNativeDeps(): Promise<void> {
    logger.info(pc.cyan(`▶ Rebuilding native modules — ${pc.bold("npm rebuild better-sqlite3")} (apps/web)`));
    const code = await runToCompletion("sh", ["-lc", "cd apps/web && npm rebuild better-sqlite3"]);
    if (code !== 0) {
        logger.error(`bun install failed (exit ${code}).`);
        process.exit(code);
    }

    if (!(await nativeDepsHealthy())) {
        logger.error(
            "better-sqlite3 still fails to load after reinstall — native ABI may not match this runtime. Try: cd src/dashboard && bun rebuild better-sqlite3"
        );
        process.exit(1);
    }

    logger.info(pc.green("✓ Native modules ready"));
}

async function ensureDeps(install: boolean, reinstall: boolean): Promise<void> {
    const present = existsSync(NODE_MODULES);

    if (present && !reinstall) {
        if (!(await nativeDepsHealthy())) {
            await rebuildNativeDeps();
        }

        return;
    }

    if (!present && !install) {
        logger.error(
            `src/dashboard/node_modules is missing and --no-install was passed. Run ${pc.bold(
                "bun install"
            )} in src/dashboard first.`
        );
        process.exit(1);
    }

    logger.info(
        pc.cyan(
            `▶ ${reinstall ? "Reinstalling" : "Installing"} dashboard dependencies — ${pc.bold(
                "bun install"
            )} (src/dashboard)`
        )
    );
    const code = await runToCompletion("bun", ["install"]);
    if (code !== 0) {
        logger.error(`bun install failed (exit ${code}).`);
        process.exit(code);
    }

    if (!(await nativeDepsHealthy())) {
        logger.error(
            "better-sqlite3 failed to load after install — try: cd src/dashboard && bun rebuild better-sqlite3"
        );
        process.exit(1);
    }

    logger.info(pc.green("✓ Dependencies ready"));
}

async function waitForServer(port: number, deadlineMs: number): Promise<boolean> {
    const url = `http://localhost:${port}/`;
    const start = Date.now();

    while (Date.now() - start < deadlineMs) {
        try {
            const res = await fetch(url, { redirect: "manual" });
            if (res.status > 0) {
                return true;
            }
        } catch {
            // server not up yet — keep polling
        }

        await Bun.sleep(500);
    }

    return false;
}

function openBrowser(url: string): void {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    const child = spawn(opener, [url], { stdio: "ignore", detached: true });
    child.on("error", (err) => {
        logger.warn(`Could not open the browser automatically (${opener}). Open ${url} manually.`, err);
    });
    child.unref();
}

async function launchProd(options: {
    open: boolean;
    install: boolean;
    reinstall: boolean;
    port: number;
}): Promise<void> {
    const { open, install, reinstall, port } = options;
    const url = `http://localhost:${port}/`;

    await ensureDeps(install, reinstall);

    logger.info(pc.cyan(`▶ Starting dashboard (production build) — ${pc.bold("bun run build:prod")}`));

    const buildCode = await runToCompletion("bun", ["run", "build:prod"]);
    if (buildCode !== 0) {
        logger.error(`Production build failed (exit ${buildCode}).`);
        process.exit(buildCode);
    }

    logger.info(pc.cyan("▶ Build complete — starting PM2 (ecosystem.config.cjs)"));
    const pm2Code = await runToCompletion("bunx", ["pm2", "start", "ecosystem.config.cjs"]);
    if (pm2Code !== 0) {
        logger.error(`PM2 start failed (exit ${pm2Code}).`);
        process.exit(pm2Code);
    }

    if (!open) {
        logger.info(pc.dim(`Server starting at ${url} (browser auto-open disabled).`));
        return;
    }

    logger.info(pc.dim(`Waiting for ${url} …`));
    const up = await waitForServer(port, 90_000);
    if (up) {
        logger.info(pc.green(`✓ Dashboard up — opening ${pc.bold(url)}`));
        openBrowser(url);
    } else {
        logger.warn(`Server did not respond within 90s. It may still be starting — open ${url} manually.`);
    }
}

const dashboardApp = defineDashboardApp({
    type: "ui",
    key: "dashboard",
    name: "Personal Dashboard",
    description: "Tasks, timers, activity log, focus modes",
    commandName: "dashboard",
    port: DEFAULT_PORT,
    spawn: {
        cmd: ["bun", "run", "dev"],
        cwd: DASHBOARD_DIR,
    },
    preflight: async () => {
        if (!existsSync(NODE_MODULES)) {
            return {
                warnings: [
                    {
                        service: "dashboard",
                        error: "src/dashboard/node_modules is missing.",
                        fix: `Run ${pc.bold("bun install")} in src/dashboard, or use bare \`tools dashboard\` to auto-install.`,
                    },
                ],
            };
        }

        if (!(await nativeDepsHealthy())) {
            await rebuildNativeDeps();
        }

        return { warnings: [] };
    },
    readiness: { kind: "http", path: "/" },
    openBrowser: { enabled: true },
    launchd: { available: true },
});

const program = new Command();

program
    .name("tools dashboard")
    .description("Start the personal productivity dashboard (auto-installs deps) and open it")
    .option("--prod", "production build + PM2 (ecosystem.config.cjs) instead of the dev server", false)
    .option("--no-open", "do not auto-open the browser")
    .option("--no-install", "do not auto-install when src/dashboard/node_modules is missing")
    .option("--reinstall", "force a fresh bun install before starting", false)
    .option("-p, --port <number>", "port to wait on / open", String(DEFAULT_PORT))
    .action(async (opts: { prod: boolean; open: boolean; install: boolean; reinstall: boolean; port: string }) => {
        const port = Number.parseInt(opts.port, 10);
        if (Number.isNaN(port)) {
            logger.error(`Invalid --port "${opts.port}".`);
            process.exit(1);
        }

        if (opts.prod) {
            await launchProd({
                open: opts.open,
                install: opts.install,
                reinstall: opts.reinstall,
                port,
            });
            return;
        }

        await ensureDeps(opts.install, opts.reinstall);
        await dashboardApp.up({ open: opts.open, port });
    });

for (const sub of dashboardApp.commanderCommand.commands) {
    program.addCommand(sub);
}

await runTool(program, { tool: "dashboard" }).catch((err: unknown) => {
    logger.error("dashboard launcher failed", err);
    process.exit(1);
});
