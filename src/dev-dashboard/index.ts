#!/usr/bin/env bun
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runShare, runShareSync, runUnshare } from "@app/dev-dashboard/commands/share";
import {
    runShareServerDevices,
    runShareServerPair,
    runShareServerServe,
    runShareServerService,
    runShareServerSetup,
    runShareServerStatus,
    runShareServerTunnel,
    SHARE_SERVER_PORT,
    shareServerDirs,
    shareServerUnit,
} from "@app/dev-dashboard/commands/share-server";
import {
    runTargetAdd,
    runTargetDefault,
    runTargetList,
    runTargetRemove,
} from "@app/dev-dashboard/commands/share-target";
import { runTunnelSetup } from "@app/dev-dashboard/commands/tunnel";
import { getConfig, saveConfig } from "@app/dev-dashboard/config";
import { createBasicAuthCredentials } from "@app/dev-dashboard/lib/auth";
import { resolveDevDashboardBindHost } from "@app/dev-dashboard/lib/bind-host";
import { generatePairingCode, savePairingCode } from "@app/dev-dashboard/lib/e2e/pairing-code";
import { startFrontProxy } from "@app/dev-dashboard/lib/front-proxy";
import { runPreviewUiServer } from "@app/dev-dashboard/lib/preview-ui-server";
import { runConfigure, runFirstTimeSetup } from "@app/dev-dashboard/lib/setup";
import { setDashboardBoundPort } from "@app/dev-dashboard/server/routes/net";
import { serveAgent } from "@app/dev-dashboard/server/serve";
import { devDashboardUiApp } from "@app/dev-dashboard/ui/app";
import { isInteractive, runTool } from "@genesiscz/utils/cli";
import { stopUiServerOnPort } from "@genesiscz/utils/DashboardApp";
import { openBrowserWhenDashboardEnv } from "@genesiscz/utils/DashboardApp/preview";
import { waitForUrlReady } from "@genesiscz/utils/DashboardApp/readiness";
import { env } from "@genesiscz/utils/env";
import { logger, out } from "@genesiscz/utils/logger";
import { findFreePort } from "@genesiscz/utils/net/free-port";
import { PROJECT_ROOT } from "@genesiscz/utils/paths";
import { killWithEscalation } from "@genesiscz/utils/process/killWithEscalation";
import type { Subprocess } from "bun";
import { Command, InvalidArgumentError } from "commander";

export async function killChild(child: ChildProcess | Subprocess, opts: { graceMs?: number } = {}): Promise<boolean> {
    return killWithEscalation(child, opts);
}

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
        const bindHost = resolveDevDashboardBindHost();
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

    const shutdown = async (signal: NodeJS.Signals) => {
        stopFrontProxy();
        await killChild(child);
        process.exit(signal === "SIGTERM" || signal === "SIGINT" ? 0 : 1);
    };

    process.on("SIGINT", () => {
        void shutdown("SIGINT");
    });
    process.on("SIGTERM", () => {
        void shutdown("SIGTERM");
    });
    process.on("SIGHUP", () => {
        void shutdown("SIGHUP");
    });
    process.on("exit", () => {
        try {
            child.kill("SIGKILL");
        } catch (err) {
            logger.debug({ err }, "Vite child kill failed on process exit (already gone?)");
        }
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
    .option("--static", "build the UI once and serve it (what `ui install` registers)")
    .action(async (opts: { dev?: boolean; static?: boolean }) => {
        if (opts.dev) {
            await runUiServer();
            return;
        }

        await runPreviewUiServer({ serve: opts.static ? "static" : "preview" });
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

const collectTargets = (value: string, previous: string[]) => [...previous, value];
const portOption = (value: string): number => Number.parseInt(value, 10);
const minFreeOption = (value: string): number => {
    const gb = Number(value);
    if (!value.trim() || !Number.isFinite(gb) || gb < 0 || gb * 1024 ** 3 > Number.MAX_SAFE_INTEGER) {
        throw new InvalidArgumentError("Enter a non-negative number of GiB.");
    }

    return gb;
};

const share = program
    .command("share")
    .description("Publish an Obsidian note to /share/<slug> on your share targets and copy the link")
    .argument("<path>", "Vault-relative or absolute path to a .md note")
    .option(
        "--target <name>",
        'share target (repeatable, or "all"); uses the configured default when omitted',
        collectTargets,
        []
    )
    .option("--no-clipboard", "Print the URL without copying it")
    .action(async (path: string, opts: { clipboard?: boolean; target: string[] }) => {
        await runShare(path, { clipboard: opts.clipboard !== false, targets: opts.target });
    });

share
    .command("sync")
    .description("Send published notes to their targets again (after an edit, or a target that was offline)")
    .argument("[notes...]", "notes (vault paths) or slugs")
    .option("--all", "every published note")
    .option("--target <name>", 'send to this target instead (repeatable, or "all")', collectTargets, [])
    .option("--prune", "also remove snapshots a target holds for notes no longer shared there")
    .action(async (notes: string[], opts: { all?: boolean; target: string[]; prune?: boolean }) => {
        await runShareSync(notes, {
            all: opts.all === true,
            targets: shareTargets(opts.target),
            prune: opts.prune === true,
        });
    });

share
    .command("unshare")
    .description("Take a note off share targets (all of them, and unpublish, when no --target is given)")
    .argument("<note>", "note (vault path) or slug")
    .option("--target <name>", "only this target (repeatable)", collectTargets, [])
    .action(async (input: string, opts: { target: string[] }) => {
        await runUnshare(input, { targets: shareTargets(opts.target) });
    });

/** `share sync x --target y`: commander hands --target to `share` itself, so a subcommand reads both. */
function shareTargets(own: string[]): string[] {
    const parent: unknown = share.opts().target;
    const inherited = Array.isArray(parent) ? parent.filter((value): value is string => typeof value === "string") : [];

    return [...new Set([...own, ...inherited])];
}

const shareTarget = share.command("target").description("Manage share targets (where shared notes are served)");

shareTarget
    .command("add")
    .description("Add a share target with the driver's guided setup (mac-live, paired, ssh-rsync)")
    .argument("<name>", "target name, e.g. home or public")
    .option("--driver [kind]", "mac-live | paired | ssh-rsync")
    .option("--url <url>", "paired: publish server origin (https://share.example.com)")
    .option("--code <code>", "paired: the one-time code from `share-server pair`")
    .option("--device-name <name>", "paired: how the server lists this Mac (default: host name)")
    .option("--host <user@host>", "ssh-rsync: ssh destination")
    .option("--data-dir <dir>", "ssh-rsync: snapshot folder on the host")
    .option("--public-base <url>", "the base of the links people get (https://host/share)")
    .option("--default", "make it the default target")
    .action(async (name: string, opts: Record<string, string | boolean | undefined>) => {
        await runTargetAdd(name, {
            driver: typeof opts.driver === "string" ? opts.driver : undefined,
            url: typeof opts.url === "string" ? opts.url : undefined,
            code: typeof opts.code === "string" ? opts.code : undefined,
            deviceName: typeof opts.deviceName === "string" ? opts.deviceName : undefined,
            host: typeof opts.host === "string" ? opts.host : undefined,
            dataDir: typeof opts.dataDir === "string" ? opts.dataDir : undefined,
            publicBase: typeof opts.publicBase === "string" ? opts.publicBase : undefined,
            default: opts.default === true,
        });
    });

shareTarget.command("list").description("List share targets (* marks the default)").action(runTargetList);
shareTarget.command("remove").argument("<name>").description("Remove a share target").action(runTargetRemove);
shareTarget.command("default").argument("<name>").description("Set the default share target").action(runTargetDefault);

const shareServer = program
    .command("share-server")
    .description("Serve note and artifact snapshots and manage paired devices");

const serverPaths = (command: Command): Command =>
    command
        .option("--data <dir>", "snapshot folder (one <kind>/<id>/ per publication)")
        .option("--state <dir>", "state folder: paired devices, the admin socket, tunnel configs");

serverPaths(shareServer.command("serve"))
    .description("Run a configured share server in the foreground")
    .option("--server <name>", "configured server (defaults to the configured default)")
    .option("--port <port>", "override the listen port", portOption)
    .option("--host <host>", "override the bind address")
    .option("--public-base <url>", "public origin, e.g. https://share.example.com")
    .option("--min-free-gb <n>", "minimum free disk space in GiB after upload (default: 2)", minFreeOption)
    .option("--pair", "print a one-time pairing code once it is up")
    .option("--tunnel <name>", "also run the cloudflared connector set up by `share-server tunnel`")
    .action(runShareServerServe);

serverPaths(shareServer.command("setup"))
    .description("Set up, update or check a share server, a client, or both; then offer pairing")
    .option("--mode [mode]", "server | client | both")
    .option("--public-base <url>", "server: public origin, e.g. https://share.example.com")
    .option("--port <port>", "server: port", portOption, SHARE_SERVER_PORT)
    .option("--user <name>", "server: service user", "genesis-share")
    .option("--root <dir>", "server: GenesisTools checkout", PROJECT_ROOT)
    .option("--bun <path>", "server: bun binary", process.execPath)
    .option("--tunnel <name>", "server: run the cloudflared connector too")
    .option("--pair", "server: print a pairing code at the end")
    .option("--target <name>", "client: share target name")
    .option("--url <url>", "client: publish server origin")
    .option("--code <code>", "client: the pairing code")
    .action(runShareServerSetup);

shareServer
    .command("up")
    .description("Enable and restart the installed share server service")
    .action(() => runShareServerService("up"));
shareServer
    .command("down")
    .description("Stop the share server service")
    .action(() => runShareServerService("down"));

serverPaths(shareServer.command("status"))
    .description("Check server health, snapshots, disk space and configured targets")
    .option("--port <port>", "port", portOption, SHARE_SERVER_PORT)
    .option("--public-base <url>", "also check health through this public origin")
    .option("--min-free-gb <n>", "minimum free disk space in GiB (default: 2)", minFreeOption)
    .option("--json", "print check results as JSON")
    .action(runShareServerStatus);

serverPaths(shareServer.command("pair"))
    .description("Print a one-time pairing code (valid 10 minutes) for `share target add --driver paired`")
    .option("--public-base <url>", "the share base to show in the hint")
    .action(runShareServerPair);

serverPaths(shareServer.command("devices"))
    .description("List paired devices, or revoke one")
    .option("--revoke <id>", "revoke this device's upload token")
    .action(runShareServerDevices);

serverPaths(shareServer.command("tunnel"))
    .description("Guided Cloudflare tunnel setup, so the share server needs no web server in front")
    .option("--name <tunnel>", "tunnel name")
    .option("--hostname <host>", "public host name, e.g. share.example.com")
    .option("--port <port>", "share server port", portOption, SHARE_SERVER_PORT)
    .action(runShareServerTunnel);

serverPaths(shareServer.command("unit"))
    .description("Print the systemd unit for this share server")
    .option("--root <dir>", "GenesisTools checkout on the server", PROJECT_ROOT)
    .option("--bun <path>", "bun binary", process.execPath)
    .option("--port <port>", "port", portOption, SHARE_SERVER_PORT)
    .option("--public-base <url>", "public base", "https://share.example.com/md")
    .option("--user <name>", "service user", "genesis-share")
    .option("--tunnel <name>", "run the cloudflared connector too")
    .action(
        (opts: {
            data?: string;
            state?: string;
            root: string;
            bun: string;
            port: number;
            publicBase: string;
            user: string;
            tunnel?: string;
        }) => {
            const dirs = shareServerDirs(opts);
            out.print(shareServerUnit({ ...opts, data: dirs.dataDir, state: dirs.stateDir }));
        }
    );

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

if (import.meta.main) {
    await runTool(program, { tool: "dev-dashboard" });
}
