#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runTunnelSetup } from "@app/dev-dashboard/commands/tunnel";
import { getConfig, saveConfig } from "@app/dev-dashboard/config";
import { createBasicAuthCredentials } from "@app/dev-dashboard/lib/auth";
import { generatePairingCode, savePairingCode } from "@app/dev-dashboard/lib/e2e/pairing-code";
import { startFrontProxy } from "@app/dev-dashboard/lib/front-proxy";
import { runPreviewUiServer } from "@app/dev-dashboard/lib/preview-ui-server";
import { runConfigure, runFirstTimeSetup } from "@app/dev-dashboard/lib/setup";
import { serveAgent } from "@app/dev-dashboard/server/serve";
import { setDashboardBoundPort } from "@app/dev-dashboard/server/routes/net";
import { devDashboardUiApp } from "@app/dev-dashboard/ui/app";
import { logger, out } from "@app/logger";
import { isInteractive, runTool } from "@app/utils/cli";
import { stopUiServerOnPort } from "@app/utils/DashboardApp";
import { openBrowserWhenDashboardEnv } from "@app/utils/DashboardApp/preview";
import { waitForUrlReady } from "@app/utils/DashboardApp/readiness";
import { env } from "@app/utils/env";
import { findFreePort } from "@app/utils/net/free-port";
import { PROJECT_ROOT } from "@app/utils/paths";
import { Command } from "commander";

const program = new Command()
    .name("dev-dashboard")
    .description("Personal dev dashboard (ttyd, cmux, obsidian)")
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

    if (isInteractive()) {
        await runFirstTimeSetup();
    }

    const { port } = await getConfig();
    const url = `http://localhost:${port}`;

    stopUiServerOnPort(port, { commandMatch: "dev-dashboard" });

    const internalPort = await findFreePort();

    out.println(`Starting dev-dashboard (Vite dev) at ${url} ...`);
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
                ...env.getProcessEnv(),
                FORCE_COLOR: "1",
                GENESIS_TOOLS_ROOT: PROJECT_ROOT,
                DEV_DASHBOARD_PUBLIC_PORT: String(port),
            },
            shell: process.platform === "win32",
        }
    );

    let frontProxy: ReturnType<typeof startFrontProxy> | undefined;

    const internalUrl = `http://127.0.0.1:${internalPort}/`;
    logger.info({ internalPort, publicPort: port }, "waiting for Vite before binding public front-proxy port");

    const viteReady = await waitForUrlReady(internalUrl, 90_000);

    if (!viteReady.ready) {
        try {
            child.kill("SIGTERM");
        } catch (killErr) {
            logger.debug({ err: killErr }, "failed terminating Vite after readiness timeout");
        }

        logger.error({ internalUrl, detail: viteReady.detail }, "Vite did not become ready");
        process.exit(1);
    }

    try {
        const bindHost = env.dashboard.getBindHost() ?? "0.0.0.0";
        frontProxy = startFrontProxy({ publicPort: port, internalPort, hostname: bindHost });
        setDashboardBoundPort(port);
        logger.info({ publicPort: port, internalPort }, "front proxy listening — upstream Vite is ready");
    } catch (err) {
        try {
            child.kill("SIGTERM");
        } catch (killErr) {
            logger.debug({ err: killErr }, "failed terminating Vite after front-proxy startup failure");
        }

        throw err;
    }
    const stopFrontProxy = () => {
        if (!frontProxy) {
            return;
        }

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

    void openBrowserWhenDashboardEnv(url);

    const exitCode: number = await new Promise((resolveExit) => {
        child.on("exit", (code) => {
            stopFrontProxy();
            resolveExit(code ?? 1);
        });
    });

    if (exitCode !== 0) {
        out.error(`\nVite exited with code ${exitCode}`);
    }

    process.exit(exitCode);
}

program
    .command("__ui-server", { hidden: true })
    .description("Internal entry: front-proxy + UI upstream + ttyd")
    .option("--dev", "Vite dev + HMR (slower over tunnel; default is watch build + preview)")
    .action(async (opts: { dev?: boolean }) => {
        if (opts.dev) {
            await runUiServer();
            return;
        }

        await runPreviewUiServer();
    });

program.addCommand(devDashboardUiApp.commanderCommand);

program
    .command("configure")
    .alias("config")
    .description("Configure dev-dashboard settings (allowed hosts, etc.)")
    .action(async () => {
        await runConfigure();
    });

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

program
    .command("agent")
    .description("Run the standalone DevDashboard Agent (API only, no Vite)")
    .option("--port <port>", "port to bind", (v) => Number.parseInt(v, 10), 3043)
    .option("--host <host>", "bind host", "0.0.0.0")
    .option("--no-advertise-mdns", "disable Bonjour/mDNS LAN advertising")
    .option("--e2e", "accept end-to-end-encrypted requests on POST /api/e2e/rpc (managed tier)")
    .action(async (opts: { port: number; host: string; advertiseMdns: boolean; e2e?: boolean }) => {
        await serveAgent({
            port: opts.port,
            host: opts.host,
            advertiseMdns: opts.advertiseMdns,
            e2e: opts.e2e === true,
        });
    });

const tunnel = program.command("tunnel").description("Manage remote access tunnels");

tunnel
    .command("setup")
    .description("Guided self-hosted Cloudflare Tunnel setup (emits a pairing QR)")
    .option("--port <port>", "local dashboard port", (v) => Number.parseInt(v, 10), 3042)
    .action(async (opts: { port: number }) => {
        await runTunnelSetup({ port: opts.port });
    });

program
    .command("pair")
    .description("Show a one-time device code to admit a phone to the managed E2E tier")
    .action(async () => {
        const code = generatePairingCode();
        const expiresAt = await savePairingCode(code);
        const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000));

        out.println("");
        out.println(`  Pairing code:  ${code}`);
        out.println(`  Enter it on your phone within ${minutes} min to admit the device. One-time use.`);
        out.println("");
    });

await runTool(program, { tool: "dev-dashboard" }).catch((err) => {
    logger.error({ err }, "dev-dashboard failed");
    process.exit(1);
});
