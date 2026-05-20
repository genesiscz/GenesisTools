#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getConfig, saveConfig } from "@app/dev-dashboard/config";
import { createBasicAuthCredentials } from "@app/dev-dashboard/lib/auth";
import { startFrontProxy } from "@app/dev-dashboard/lib/front-proxy";
import { findFreePort } from "@app/dev-dashboard/lib/ttyd/free-port";
import { logger, out } from "@app/logger";
import { runTool } from "@app/utils/cli";
import { defineDashboardApp } from "@app/utils/DashboardApp";
import { waitForUrlReady } from "@app/utils/DashboardApp/readiness";
import { PROJECT_ROOT } from "@app/utils/paths";
import { Command } from "commander";

const program = new Command()
    .name("dev-dashboard")
    .description("Personal dev dashboard (ttyd, cmux, obsidian) at mac.foltyn.dev")
    .version("0.1.0");

async function runUiServer(): Promise<void> {
    const uiDir = resolve(import.meta.dirname, "ui");
    const configPath = resolve(uiDir, "vite.config.ts");
    const viteEntry = resolve(PROJECT_ROOT, "node_modules", "vite", "bin", "vite.js");

    if (!existsSync(configPath)) {
        out.error(`Could not find dev-dashboard Vite config at ${configPath}`);
        process.exit(1);
    }

    if (!existsSync(viteEntry)) {
        out.error(`Could not find Vite at ${viteEntry}`);
        out.error(`Run "bun install" in ${PROJECT_ROOT} first.`);
        process.exit(1);
    }

    const { port } = await getConfig();
    const url = `http://localhost:${port}`;
    // Vite runs on a private loopback port; a Bun.serve front proxy owns the
    // public port so WebSockets (ttyd + Vite HMR) work — Bun's node:http
    // upgrade socket is broken (oven-sh/bun#28396).
    const internalPort = await findFreePort();

    out.println(`Starting dev-dashboard at ${url} ...`);
    out.println("(first start can take a few seconds; output below comes from Vite)\n");

    const child = spawn(
        "bun",
        [
            "--bun",
            viteEntry,
            "dev",
            "--config",
            configPath,
            "--strictPort",
            "--port",
            String(internalPort),
            "--host",
            "127.0.0.1",
        ],
        {
            cwd: PROJECT_ROOT,
            stdio: "inherit",
            env: {
                ...process.env,
                FORCE_COLOR: "1",
                GENESIS_TOOLS_ROOT: PROJECT_ROOT,
                DEV_DASHBOARD_PUBLIC_PORT: String(port),
            },
            shell: process.platform === "win32",
        }
    );

    // Teardown hooks below are registered after this line; if startFrontProxy
    // throws, the already-spawned Vite child would be orphaned. Kill it here.
    let frontProxy: ReturnType<typeof startFrontProxy>;

    try {
        const bindHost = process.env.DASHBOARD_BIND_HOST ?? "0.0.0.0";
        frontProxy = startFrontProxy({ publicPort: port, internalPort, hostname: bindHost });
    } catch (err) {
        try {
            child.kill("SIGTERM");
        } catch (killErr) {
            logger.debug({ err: killErr }, "failed terminating Vite after front-proxy startup failure");
        }

        throw err;
    }
    const stopFrontProxy = () => {
        try {
            frontProxy.stop(true);
        } catch (err) {
            logger.debug({ err }, "front proxy stop failed (already stopped?)");
        }
    };

    child.on("error", (err) => {
        logger.error({ err }, "failed to start Vite");
        stopFrontProxy();
        process.exit(1);
    });

    const killChild = () => {
        try {
            child.kill("SIGTERM");
        } catch (err) {
            logger.debug({ err }, "Vite child kill failed (already gone?)");
        }
    };

    const shutdown = (signal: NodeJS.Signals) => {
        stopFrontProxy();
        killChild();
        process.exit(signal === "SIGTERM" || signal === "SIGINT" ? 0 : 1);
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGHUP", () => shutdown("SIGHUP"));
    process.on("exit", () => {
        killChild();
    });

    // Foreground-only browser open (launchd/background restarts must not pop a tab).
    // Lifecycle sets DASHBOARD_OPEN_BROWSER=1 when the user asked for --open.
    if (process.env.DASHBOARD_OPEN_BROWSER === "1") {
        void (async () => {
            const ready = await waitForUrlReady(url, 20_000);

            if (!ready.ready) {
                logger.warn({ url, detail: ready.detail }, "dev-dashboard browser open skipped — page not ready");
                return;
            }

            const [cmd, args] =
                process.platform === "darwin"
                    ? (["open", [url]] as const)
                    : process.platform === "win32"
                      ? (["cmd", ["/c", "start", "", url]] as const)
                      : (["xdg-open", [url]] as const);
            const opener = spawn(cmd, args, { stdio: "ignore", detached: true });
            opener.on("error", (err) => logger.debug({ err, cmd }, "failed to auto-open browser"));
            opener.unref();
        })();
    }

    const exitCode: number = await new Promise((resolveExit) => {
        child.on("exit", (code) => resolveExit(code ?? 1));
    });

    if (exitCode !== 0) {
        out.error(`\nVite exited with code ${exitCode}`);
    }

    process.exit(exitCode);
}

const devDashboardApp = defineDashboardApp({
    type: "ui",
    key: "dev-dashboard",
    name: "Dev Dashboard",
    description: "Launch the dev-dashboard front-proxy + Vite + ttyd",
    commandName: "ui",
    aliases: ["dashboard"],
    bindHost: "0.0.0.0",
    spawn: {
        cmd: [process.execPath, process.argv[1], "__ui-server"],
        cwd: PROJECT_ROOT,
    },
    readiness: { kind: "http", path: "/" },
    openBrowser: { enabled: false },
    launchd: { available: true },
});

program
    .command("__ui-server", { hidden: true })
    .description("Internal entry: front-proxy + Vite + ttyd")
    .action(async () => {
        await runUiServer();
    });

program.addCommand(devDashboardApp.commanderCommand);

const auth = program.command("auth").description("Manage dev-dashboard Basic Auth");

auth.command("reset")
    .description("Reset the Basic Auth username/password")
    .option("--username <username>", "Basic Auth username", "martin")
    .option("--password <password>", "Basic Auth password; generated when omitted")
    .action(async (options: { username: string; password?: string }) => {
        const config = await getConfig();
        const { auth: nextAuth, password } = createBasicAuthCredentials({
            username: options.username,
            password: options.password,
        });
        await saveConfig({ ...config, auth: nextAuth });

        out.println("dev-dashboard Basic Auth updated");
        out.println(`username: ${nextAuth.username}`);
        out.println(`password: ${password}`);
    });

await runTool(program, { tool: "dev-dashboard" }).catch((err) => {
    logger.error({ err }, "dev-dashboard failed");
    process.exit(1);
});
