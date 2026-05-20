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
        frontProxy = startFrontProxy({ publicPort: port, internalPort });
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

    // Open the browser only AFTER Vite is actually serving — the page load is
    // what triggers /api/ttyd/spawn, so a blind 2s timer opened it before Vite
    // was up and the proxy spammed ECONNREFUSED for Vite + the just-spawned
    // ttyd. Poll the internal Vite port; ttyd is now effectively deferred until
    // Vite is ready (no extra ttyd-lifecycle changes needed).
    void (async () => {
        const deadline = Date.now() + 20_000;
        const internalUrl = `http://127.0.0.1:${internalPort}/`;
        while (Date.now() < deadline) {
            try {
                await fetch(internalUrl, { signal: AbortSignal.timeout(1000) });
                break; // any response (even 404) means Vite is listening
            } catch (err) {
                logger.debug({ err, internalUrl }, "vite readiness probe retry (not up yet)");
                await new Promise((r) => setTimeout(r, 250));
            }
        }

        // Best-effort browser open. Detached spawns have no "error" listener by
        // default; an unhandled "error" (opener binary missing) would crash the
        // dashboard, so swallow it.
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
    spawn: {
        cmd: [process.execPath, process.argv[1], "__ui-server"],
        cwd: PROJECT_ROOT,
        env: process.env as Record<string, string | undefined>,
    },
    readiness: {
        kind: "log",
        regex: /ready in \d+\s*m?s|Local:\s*http|localhost:\d+|press h \+ enter/i,
        timeoutMs: 30_000,
    },
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
