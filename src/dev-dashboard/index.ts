#!/usr/bin/env bun
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveShareTargetFlags, runShare, runShareSync, runUnshare } from "@app/dev-dashboard/commands/share";
import { runShareAutoSync } from "@app/dev-dashboard/commands/share-auto-sync";
import {
    runShareServerAudit,
    runShareServerDevices,
    runShareServerPair,
    runShareServerServe,
    runShareServerService,
    runShareServerSetup,
    runShareServerStatus,
    runShareServerTunnel,
    runShareServerUnit,
    SHARE_SERVER_PORT,
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
import { pickEnumFlag } from "@genesiscz/utils/cli/enum-flag";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { stopUiServerOnPort } from "@genesiscz/utils/DashboardApp";
import { openBrowserWhenDashboardEnv } from "@genesiscz/utils/DashboardApp/preview";
import { waitForUrlReady } from "@genesiscz/utils/DashboardApp/readiness";
import { env } from "@genesiscz/utils/env";
import { logger, out } from "@genesiscz/utils/logger";
import { findFreePort } from "@genesiscz/utils/net/free-port";
import { PROJECT_ROOT } from "@genesiscz/utils/paths";
import { killWithEscalation } from "@genesiscz/utils/process/killWithEscalation";
import type { Subprocess } from "bun";
import { Command, InvalidArgumentError, Option } from "commander";

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

const targetOption = (description: string) =>
    new Option("--target [name]", description)
        .preset(true)
        .default([])
        .argParser((value: string | true, previous: Array<string | true>) => [...previous, value]);
const integerOption =
    ({ minimum, maximum, label }: { minimum: number; maximum: number; label: string }) =>
    (value: string): number => {
        const parsed = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
            throw new InvalidArgumentError(`Enter ${label} as an integer from ${minimum} through ${maximum}.`);
        }

        return parsed;
    };
const portOption = integerOption({ minimum: 1, maximum: 65535, label: "port" });
const minFreeOption = (value: string): number => {
    const gb = Number(value);
    if (!value.trim() || !Number.isFinite(gb) || gb < 0 || gb * 1024 ** 3 > Number.MAX_SAFE_INTEGER) {
        throw new InvalidArgumentError("Enter a non-negative number of GiB.");
    }

    return gb;
};

const AUTO_SYNC_STATES = ["status", "on", "off"] as const;

function isAutoSyncState(value: string): value is (typeof AUTO_SYNC_STATES)[number] {
    return (AUTO_SYNC_STATES as readonly string[]).includes(value);
}

const share = program
    .command("share")
    .description("Publish an Obsidian note to its configured share targets and copy the link")
    .argument("<path>", "Vault-relative or absolute path to a .md note")
    .addOption(targetOption('share target (repeatable, or "all"); uses the configured default when omitted'))
    .option("--no-clipboard", "Print the URL without copying it")
    .action(async (path: string, opts: { clipboard?: boolean; target: Array<string | true> }) => {
        const targets = await resolveShareTargetFlags(opts.target, ["share", path]);
        if (targets) {
            await runShare(path, { clipboard: opts.clipboard !== false, targets });
        }
    });

share
    .command("sync")
    .description("Send published notes to their targets again (after an edit, or a target that was offline)")
    .argument("[notes...]", "notes (vault paths) or slugs")
    .option("--all", "every published note")
    .addOption(targetOption('send to this target instead (repeatable, or "all")'))
    .option("--prune", "also remove snapshots a target holds for notes no longer shared there")
    .option("--changed", "only notes edited since their last sync (what auto-sync runs)")
    .action(
        async (
            notes: string[],
            opts: { all?: boolean; target: Array<string | true>; prune?: boolean; changed?: boolean }
        ) => {
            const targets = await resolveShareTargetFlags(shareTargets(opts.target), [
                "share",
                "sync",
                ...notes,
                ...(opts.all ? ["--all"] : []),
                ...(opts.prune ? ["--prune"] : []),
                ...(opts.changed ? ["--changed"] : []),
            ]);
            if (targets) {
                await runShareSync(notes, {
                    all: opts.all === true,
                    targets,
                    prune: opts.prune === true,
                    changed: opts.changed === true,
                });
            }
        }
    );

share
    .command("auto-sync")
    .description("Send published notes edited since their last sync every N minutes, through a tools daemon task")
    .argument("[state]", "on, off or status (default: status)")
    .option(
        "--every <minutes>",
        "how often, in minutes (default 10)",
        integerOption({ minimum: 1, maximum: 1440, label: "minutes" })
    )
    .action(async (state: string | undefined, opts: { every?: number }) => {
        const picked = await pickEnumFlag({
            tool: toolCommand("dev-dashboard", "share", "auto-sync"),
            subcommand: ["share", "auto-sync"],
            flag: "state",
            given: state,
            values: AUTO_SYNC_STATES,
            fallback: "status",
            accepts: isAutoSyncState,
        });
        if (picked) {
            await runShareAutoSync({ state: picked, everyMinutes: opts.every });
        }
    });

share
    .command("unshare")
    .description("Take a note off share targets (all of them, and unpublish, when no --target is given)")
    .argument("<note>", "note (vault path) or slug")
    .addOption(targetOption("only this target (repeatable)"))
    .action(async (input: string, opts: { target: Array<string | true> }) => {
        const targets = await resolveShareTargetFlags(shareTargets(opts.target), ["share", "unshare", input]);
        if (targets) {
            await runUnshare(input, { targets });
        }
    });

/** Commander can assign a subcommand's --target to share itself. */
function shareTargets(own: Array<string | true>): Array<string | true> {
    const parent = share.opts<{ target: Array<string | true> }>().target;
    return [...new Set([...own, ...parent])];
}

const shareTarget = share.command("target").description("Manage share targets (where shared notes are served)");

shareTarget
    .command("add")
    .description("Add a share target with the driver's guided setup (mac-live, paired, ssh-rsync)")
    .argument("<name>", "target name, e.g. home or public")
    .option("--driver [kind]", "mac-live | paired | ssh-rsync")
    .option("--url <url>", "paired: publish server origin (https://share.example.com)")
    .option("--code <code>", "paired: one-time code (prefer the hidden prompt or --code-stdin)")
    .option("--code-stdin", "paired: read the one-time code from stdin")
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
            codeStdin: opts.codeStdin === true,
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
        .option("--state <dir>", "state folder: paired devices, the admin socket, tunnel configs")
        .option("--config-home <dir>", "home whose share configuration should be read");

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
    .description("Configure a publish server, pair this computer, or do both")
    .option("--role [role]", "server | client | both")
    .option("--mode [mode]", "alias for --role")
    .option("--server <name>", "server name")
    .option("--target [name]", "client target name or picker")
    .option("--yes", "use defaults and authorize service installation")
    .option("--public-origin <url>", "public origin of the server")
    .option("--public-base <url>", "alias for --public-origin")
    .option("--port <port>", "listen port", portOption)
    .option("--host <host>", "listen host")
    .option("--data-dir <dir>", "snapshot directory")
    .option("--state-dir <dir>", "device and socket directory")
    .option("--exposure [kind]", "reverse-proxy | cloudflared | local")
    .option("--proxy [proxy]", "apache | nginx | caddy | other")
    .option("--tunnel <name>", "cloudflared tunnel name")
    .option("--service [manager]", "systemd | launchd | none")
    .option("--service-user <name>", "systemd service account")
    .option("--user <name>", "alias for --service-user")
    .option("--adopt-unit <path>", "adopt an existing flag-based systemd unit")
    .option("--root <dir>", "GenesisTools checkout", PROJECT_ROOT)
    .option("--bun <path>", "Bun executable", process.execPath)
    .option("--pair", "print a pairing code when the server is ready")
    .option("--url <url>", "client: publish server URL")
    .option("--code <code>", "client: one-time code (prefer the hidden prompt or --code-stdin)")
    .option("--code-stdin", "client: read the one-time code from stdin")
    .option("--default", "make the client target the default")
    .action(runShareServerSetup);

shareServer
    .command("up")
    .description("Enable and restart the configured service")
    .option("--config-home <dir>", "home whose share configuration should be read")
    .option("--server <name>", "server to restart")
    .action((opts: { server?: string; configHome?: string }) => runShareServerService("up", opts));
shareServer
    .command("down")
    .description("Stop the configured service")
    .option("--config-home <dir>", "home whose share configuration should be read")
    .option("--server <name>", "server to stop")
    .action((opts: { server?: string; configHome?: string }) => runShareServerService("down", opts));

serverPaths(shareServer.command("status"))
    .description("Check servers, disk space and configured client targets")
    .option("--server <name>", "check this configured server")
    .option("--port <port>", "override the listen port", portOption)
    .option("--public-base <url>", "override the public health origin")
    .option("--min-free-gb <n>", "override the minimum free disk space in GiB", minFreeOption)
    .option("--json", "print check results as JSON")
    .action(runShareServerStatus);

shareServer
    .command("audit")
    .description("Read publish access records")
    .option("--config-home <dir>", "home whose share configuration should be read")
    .option("--server <name>", "read the named server's access log")
    .option("--client", "read this computer's publishing log")
    .option("--since <time>", "filter by an ISO time or a duration such as 7d")
    .option("--device <id>", "filter by device id")
    .option("--json", "print records as JSON")
    .action(runShareServerAudit);

serverPaths(shareServer.command("pair"))
    .description("Print a one-time pairing code (valid for 10 minutes)")
    .option("--server <name>", "server to pair with")
    .option("--public-base <url>", "override the origin in the pairing command")
    .action(runShareServerPair);

serverPaths(shareServer.command("devices"))
    .description("List server and client devices, or revoke a server device")
    .option("--server <name>", "server to read or change")
    .option("--revoke <id>", "revoke a device's upload token")
    .action(runShareServerDevices);

serverPaths(shareServer.command("tunnel"))
    .description("Guided Cloudflare tunnel setup, so the share server needs no web server in front")
    .option("--name <tunnel>", "tunnel name")
    .option("--hostname <host>", "public host name, e.g. share.example.com")
    .option("--port <port>", "share server port", portOption, SHARE_SERVER_PORT)
    .action(runShareServerTunnel);

serverPaths(shareServer.command("unit"))
    .description("Print the configured server's systemd unit or launchd plist")
    .option("--server <name>", "configured server")
    .option("--root <dir>", "GenesisTools checkout", PROJECT_ROOT)
    .option("--bun <path>", "Bun executable", process.execPath)
    .action(runShareServerUnit);

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
