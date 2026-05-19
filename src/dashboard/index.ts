#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "@app/logger";
import { Command } from "commander";
import pc from "picocolors";

const DASHBOARD_DIR = dirname(fileURLToPath(import.meta.url));
const NODE_MODULES = join(DASHBOARD_DIR, "node_modules");
const DEFAULT_PORT = 3000;

interface LaunchOptions {
    prod: boolean;
    open: boolean;
    install: boolean;
    reinstall: boolean;
    port: number;
}

function runToCompletion(cmd: string, args: string[]): Promise<number> {
    const child = spawn(cmd, args, { cwd: DASHBOARD_DIR, stdio: "inherit" });
    return new Promise((res) => child.on("exit", (code) => res(code ?? 1)));
}

async function ensureDeps(install: boolean, reinstall: boolean): Promise<void> {
    const present = existsSync(NODE_MODULES);

    if (present && !reinstall) {
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

async function launch(options: LaunchOptions): Promise<void> {
    const { prod, open, install, reinstall, port } = options;
    const url = `http://localhost:${port}/`;

    await ensureDeps(install, reinstall);

    logger.info(
        pc.cyan(
            `▶ Starting dashboard (${prod ? "production build" : "dev"}) — ${pc.bold(
                `bun run ${prod ? "build:prod" : "dev"}`
            )}`
        )
    );

    if (prod) {
        const buildCode = await runToCompletion("bun", ["run", "build:prod"]);
        if (buildCode !== 0) {
            logger.error(`Production build failed (exit ${buildCode}).`);
            process.exit(buildCode);
        }

        logger.info(pc.cyan("▶ Build complete — starting PM2 (ecosystem.config.cjs)"));
        spawn("bunx", ["pm2", "start", "ecosystem.config.cjs"], { cwd: DASHBOARD_DIR, stdio: "inherit" });
    } else {
        spawn("bun", ["run", "dev"], { cwd: DASHBOARD_DIR, stdio: "inherit" });
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

        await launch({
            prod: opts.prod,
            open: opts.open,
            install: opts.install,
            reinstall: opts.reinstall,
            port,
        });
    });

program.parseAsync(process.argv).catch((err: unknown) => {
    logger.error("dashboard launcher failed", err);
    process.exit(1);
});
