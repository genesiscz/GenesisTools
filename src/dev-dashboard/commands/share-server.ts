import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runTargetAdd } from "@app/dev-dashboard/commands/share-target";
import { ADMIN_API, DeviceListSchema, PairCodeResponseSchema } from "@app/dev-dashboard/lib/share/server/api";
import {
    adminRequest,
    parsePublicBase,
    SHARE_SERVER_HEADER,
    startShareServer,
} from "@app/dev-dashboard/lib/share/server/app";
import {
    cloudflaredConfig,
    HOSTNAME_RE,
    startTunnelConnector,
    TUNNEL_NAME_RE,
    tunnelConfigPath,
    tunnelSetupSteps,
} from "@app/dev-dashboard/lib/share/server/tunnel";
import { listSnapshotSlugs } from "@app/dev-dashboard/lib/share/server/upload";
import { Executor, isInteractive, suggestCommand, suggestEnumFlag } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { genesisToolsDirIn, toolDataDir } from "@genesiscz/utils/storage/root";
import { WEB_SERVICES } from "@genesiscz/utils/ui/dashboards";
import { z } from "zod";

const { log } = logger.scoped("share-server");
const TOOL = "tools dev-dashboard share-server";

export const SHARE_SERVER_PORT = WEB_SERVICES["dev-dashboard-share-server"].port;

export interface ShareServerPaths {
    data?: string;
    state?: string;
}

export function shareServerDirs(opts: ShareServerPaths): { dataDir: string; stateDir: string } {
    return {
        dataDir: opts.data ?? toolDataDir("dev-dashboard", "share-server", "data"),
        stateDir: opts.state ?? toolDataDir("dev-dashboard", "share-server", "state"),
    };
}

export interface ShareServerServeOptions extends ShareServerPaths {
    port: number;
    host: string;
    publicBase?: string;
    pair?: boolean;
    tunnel?: string;
}

function fail(message: string, suggestion?: string): void {
    out.error(message);

    if (suggestion) {
        out.printlnErr(suggestion);
    }

    process.exitCode = 1;
}

async function printPairCode(stateDir: string, publicBase: string): Promise<void> {
    const { code, expiresAt } = PairCodeResponseSchema.parse(
        await adminRequest({ stateDir, path: ADMIN_API.pairCode, method: "POST" })
    );
    out.println(`pairing code: ${code} (valid until ${new Date(expiresAt).toLocaleString()})`);
    out.println(
        `on the Mac: tools dev-dashboard share target add <name> --driver paired --url ${publicBase} --code ${code}`
    );
}

/** `share-server serve`: run the share server in the foreground (what the service unit runs). */
export async function runShareServerServe(opts: ShareServerServeOptions): Promise<void> {
    const { dataDir, stateDir } = shareServerDirs(opts);
    const publicBase = opts.publicBase ?? `http://${opts.host}:${opts.port}/md`;

    try {
        parsePublicBase(publicBase);
    } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }

    let configFile: string | null = null;

    if (opts.tunnel) {
        configFile = tunnelConfigPath(stateDir, opts.tunnel);

        if (!existsSync(configFile)) {
            return fail(
                `no cloudflared config for tunnel "${opts.tunnel}" at ${configFile}`,
                suggestCommand(TOOL, { replaceCommand: ["tunnel", "--name", opts.tunnel, "--hostname", "<host>"] })
            );
        }
    }

    const server = await startShareServer({ dataDir, stateDir, publicBase, port: opts.port, host: opts.host });
    out.println(
        `share server on ${server.url}${server.context.pagePath}/<slug> (data ${dataDir}, public ${publicBase})`
    );

    if (opts.pair) {
        await printPairCode(stateDir, publicBase);
    }

    if (opts.tunnel && configFile) {
        const connector = startTunnelConnector({ name: opts.tunnel, configFile });
        const code = await connector.exited;
        // The connector is half of the service: when it dies, exit so the supervisor restarts both.
        log.error({ code, tunnel: opts.tunnel }, "the cloudflared connector exited");
        await server.stop();
        process.exit(code === 0 ? 1 : code);
    }
}

/** `share-server status`: is this server answering on the port, and what does it hold. */
export async function runShareServerStatus(opts: ShareServerPaths & { port: number }): Promise<void> {
    const { dataDir, stateDir } = shareServerDirs(opts);
    const url = `http://127.0.0.1:${opts.port}/`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch((err: unknown) => {
        log.debug({ err, url }, "share server did not answer");
        return null;
    });
    const ours = res?.headers.get(SHARE_SERVER_HEADER) !== null && res !== null;
    out.println(`server:    ${ours ? "up" : res ? "another server holds the port" : "down"} (${url})`);
    out.println(`snapshots: ${(await listSnapshotSlugs(dataDir)).length} in ${dataDir}`);

    if (ours) {
        const devices = await adminRequest({ stateDir, path: ADMIN_API.devices }).catch((err: unknown) => {
            log.debug({ err }, "admin socket did not answer");
            return null;
        });
        const parsed = DeviceListSchema.safeParse(devices);
        out.println(
            `devices:   ${parsed.success ? parsed.data.devices.length : "unknown (no access to the admin socket)"}`
        );
    }

    if (!ours) {
        process.exitCode = 1;
    }

    await out.flush();
}

export async function runShareServerPair(opts: ShareServerPaths & { publicBase?: string }): Promise<void> {
    const { stateDir } = shareServerDirs(opts);

    try {
        await printPairCode(stateDir, opts.publicBase ?? "<server public base, e.g. https://share.example.com/md>");
    } catch (err) {
        fail(`${err instanceof Error ? err.message : String(err)} (is the share server up, with this --state?)`);
    }

    await out.flush();
}

export async function runShareServerDevices(opts: ShareServerPaths & { revoke?: string }): Promise<void> {
    const { stateDir } = shareServerDirs(opts);

    try {
        if (opts.revoke) {
            await adminRequest({ stateDir, path: ADMIN_API.device(opts.revoke), method: "DELETE" });
            out.println(`revoked ${opts.revoke}`);
        } else {
            const { devices } = DeviceListSchema.parse(await adminRequest({ stateDir, path: ADMIN_API.devices }));

            for (const device of devices) {
                out.println(
                    `${device.id}\t${device.name}\tpaired ${device.createdAt}\tlast used ${device.lastUsedAt ?? "never"}`
                );
            }

            if (devices.length === 0) {
                out.printlnErr("no paired devices");
            }
        }
    } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
    }

    await out.flush();
}

const TunnelListSchema = z.array(z.object({ id: z.string(), name: z.string() }));

async function runStep(command: string[]): Promise<boolean> {
    const proc = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });

    return (await proc.exited) === 0;
}

/**
 * `share-server tunnel`: give this share server a public hostname through a Cloudflare tunnel, with no web server
 * in front. It walks the cloudflared steps (asking before each), then writes the connector config that
 * `share-server up --tunnel <name>` runs.
 */
export async function runShareServerTunnel(
    opts: ShareServerPaths & { name?: string; hostname?: string; port: number }
): Promise<void> {
    const { stateDir } = shareServerDirs(opts);

    if (!opts.name || !TUNNEL_NAME_RE.test(opts.name) || !opts.hostname || !HOSTNAME_RE.test(opts.hostname)) {
        return fail(
            "--name <tunnel> and --hostname <public host> are required",
            suggestCommand(TOOL, { replaceCommand: ["tunnel", "--name", "share", "--hostname", "share.example.com"] })
        );
    }

    const steps = tunnelSetupSteps({ name: opts.name, hostname: opts.hostname });

    if (!isInteractive()) {
        out.println("Run these on the server, then this command again in a terminal to write the config:");

        for (const step of steps) {
            out.println(`  ${step.command.join(" ")}    # ${step.why}`);
        }

        return;
    }

    if (!(await runStep(["cloudflared", "--version"]))) {
        return fail(
            "cloudflared is not installed: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
        );
    }

    for (const step of steps) {
        const skipLogin = step.interactive && existsSync(join(homedir(), ".cloudflared", "cert.pem"));
        const go = await p.confirm({
            message: `${step.why}: ${step.command.join(" ")}${skipLogin ? " (already logged in)" : ""}`,
            initialValue: !skipLogin,
        });

        if (go && !(await runStep(step.command))) {
            return fail(`${step.command.join(" ")} failed; fix it and run this command again`);
        }
    }

    const list = Bun.spawnSync(["cloudflared", "tunnel", "list", "-o", "json"]);
    const tunnels = TunnelListSchema.parse(SafeJSON.parse(list.stdout.toString() || "[]", { strict: true }));
    const tunnel = tunnels.find((entry) => entry.name === opts.name);

    if (!tunnel) {
        return fail(`tunnel "${opts.name}" is not in \`cloudflared tunnel list\``);
    }

    const configFile = tunnelConfigPath(stateDir, opts.name);
    await writeFile(
        configFile,
        cloudflaredConfig({
            tunnelId: tunnel.id,
            credentialsFile: join(homedir(), ".cloudflared", `${tunnel.id}.json`),
            hostname: opts.hostname,
            port: opts.port,
        })
    );
    out.println(`wrote ${configFile}`);
    out.println(`then: ${TOOL} setup --tunnel ${opts.name} --public-base https://${opts.hostname}/md`);
}

/** `share-server unit`: the systemd unit that runs the share server from a GenesisTools checkout. */
export function shareServerUnit(opts: {
    root: string;
    bun: string;
    data: string;
    state: string;
    port: number;
    publicBase: string;
    user: string;
    tunnel?: string;
}): string {
    const args = [
        `${opts.root}/src/dev-dashboard/index.ts`,
        "share-server",
        "serve",
        `--data ${opts.data}`,
        `--state ${opts.state}`,
        `--port ${opts.port}`,
        "--host 127.0.0.1",
        `--public-base ${opts.publicBase}`,
        ...(opts.tunnel ? [`--tunnel ${opts.tunnel}`] : []),
    ];

    return [
        "[Unit]",
        "Description=GenesisTools share server (public pages from note snapshots, paired uploads)",
        "After=network-online.target",
        "Wants=network-online.target",
        "",
        "[Service]",
        "Type=simple",
        `User=${opts.user}`,
        `Group=${opts.user}`,
        `WorkingDirectory=${opts.root}`,
        `ExecStart=${opts.bun} ${args.join(" ")}`,
        "Restart=on-failure",
        "RestartSec=5",
        `Environment=HOME=${opts.state}`,
        `Environment=GENESIS_TOOLS_HOME=${genesisToolsDirIn(opts.state)}`,
        "NoNewPrivileges=yes",
        "PrivateTmp=yes",
        "ProtectSystem=strict",
        "ProtectHome=yes",
        `ReadWritePaths=${opts.data} ${opts.state}`,
        "",
        "[Install]",
        "WantedBy=multi-user.target",
        "",
    ].join("\n");
}

/** The systemd service `share-server setup` installs and `up` / `down` start and stop. */
export const SHARE_SERVER_SERVICE = "genesis-share-server";
const UNIT_PATH = `/etc/systemd/system/${SHARE_SERVER_SERVICE}.service`;
const systemd = new Executor({ label: "share-server-systemd", timeout: { ms: 30_000, reason: "one systemctl call" } });

function hasSystemd(): boolean {
    return process.platform === "linux" && existsSync("/run/systemd/system");
}

async function systemctl(args: string[]): Promise<boolean> {
    const result = await systemd.exec(["systemctl", ...args], {
        timeout: { ms: 90_000, reason: "systemctl waits for the service to start or stop" },
    });

    if (!result.success) {
        out.error(`systemctl ${args.join(" ")}: ${result.stderr || result.stdout}`);
    }

    return result.success;
}

/** `share-server up` / `down`: start (and enable) or stop (and disable) the installed service. */
export async function runShareServerService(action: "up" | "down"): Promise<void> {
    if (!hasSystemd()) {
        return fail(
            "up/down manage the systemd service; this machine has no systemd",
            `run it in the foreground instead: ${TOOL} serve --public-base <url>`
        );
    }

    if (!existsSync(UNIT_PATH)) {
        return fail(
            `${UNIT_PATH} is not installed`,
            suggestCommand(TOOL, { replaceCommand: ["setup", "--mode", "server"] })
        );
    }

    const ok = await systemctl(
        action === "up" ? ["enable", "--now", SHARE_SERVER_SERVICE] : ["disable", "--now", SHARE_SERVER_SERVICE]
    );

    if (ok) {
        out.println(`${SHARE_SERVER_SERVICE} ${action === "up" ? "started" : "stopped"}`);
    } else {
        process.exitCode = 1;
    }
}

export const SHARE_SETUP_MODES = ["server", "client", "both"] as const;
export type ShareSetupMode = (typeof SHARE_SETUP_MODES)[number];

export interface ShareServerSetupOptions extends ShareServerPaths {
    mode?: string;
    publicBase?: string;
    port: number;
    user: string;
    root: string;
    bun: string;
    tunnel?: string;
    pair?: boolean;
    /** client part: the target name, server URL and pairing code (`share target add`). */
    target?: string;
    url?: string;
    code?: string;
}

async function ask(message: string, given: string | undefined, initial?: string): Promise<string | null> {
    if (given) {
        return given;
    }

    if (!isInteractive()) {
        return null;
    }

    return p.text({ message, initialValue: initial });
}

/**
 * The server part of setup, also its update and its check: the unit it would write against the one installed, the
 * service state, and what `status` sees. With root on a systemd host it writes the unit and starts it; otherwise it
 * prints the unit for the host's own config management (GenesisInfra on the vpn host).
 */
async function setupServer(opts: ShareServerSetupOptions): Promise<boolean> {
    const publicBase = await ask(
        "Public base of the pages (origin + one path, e.g. https://share.example.com/md)",
        opts.publicBase
    );

    if (!publicBase) {
        fail(
            "--public-base is required",
            suggestCommand(TOOL, {
                replaceCommand: ["setup", "--mode", "server", "--public-base", "https://share.example.com/md"],
            })
        );
        return false;
    }

    parsePublicBase(publicBase);
    const { dataDir, stateDir } = shareServerDirs(opts);
    const unit = shareServerUnit({
        root: opts.root,
        bun: opts.bun,
        data: dataDir,
        state: stateDir,
        port: opts.port,
        publicBase,
        user: opts.user,
        tunnel: opts.tunnel,
    });
    const installed = await readFile(UNIT_PATH, "utf8").catch(() => null);
    out.println(
        `unit ${UNIT_PATH}: ${installed === null ? "not installed" : installed === unit ? "up to date" : "differs from this setup"}`
    );

    if (installed === unit) {
        await runShareServerStatus({ ...opts, port: opts.port });
        return true;
    }

    const canWrite = hasSystemd() && process.getuid?.() === 0;

    if (
        !canWrite ||
        !isInteractive() ||
        !(await p.confirm({ message: `Write ${UNIT_PATH} and (re)start the service?` }))
    ) {
        out.println("The unit for this setup (install it with your host's config management, then share-server up):");
        out.print(unit);
        return true;
    }

    await mkdir(dataDir, { recursive: true });
    await writeFile(UNIT_PATH, unit);
    const ok = (await systemctl(["daemon-reload"])) && (await systemctl(["enable", "--now", SHARE_SERVER_SERVICE]));
    await systemctl(["restart", SHARE_SERVER_SERVICE]);

    return ok;
}

/** `share-server setup`: set up, update or check a share server, a client (this Mac), or both, then offer pairing. */
export async function runShareServerSetup(opts: ShareServerSetupOptions): Promise<void> {
    let mode = opts.mode;

    if (!mode && isInteractive()) {
        mode = await p.select({
            message: "What should this machine be?",
            options: [
                { value: "server", label: "server", hint: "serves shared pages and takes paired uploads" },
                { value: "client", label: "client", hint: "shares notes to a paired server" },
                { value: "both", label: "both", hint: "a server that also shares its own notes" },
            ],
        });
    }

    const known: readonly string[] = SHARE_SETUP_MODES;

    if (!mode || !known.includes(mode)) {
        out.printlnErr(suggestEnumFlag(`${TOOL} setup`, "--mode", SHARE_SETUP_MODES));
        process.exitCode = 1;
        return;
    }

    try {
        if (mode !== "client" && !(await setupServer(opts))) {
            process.exitCode = 1;
            return;
        }

        if (mode !== "client") {
            const pairNow =
                opts.pair ??
                (isInteractive() ? await p.confirm({ message: "Pair a computer with this server now?" }) : false);

            if (pairNow) {
                await runShareServerPair({ ...opts, publicBase: opts.publicBase });
            }
        }

        if (mode !== "server") {
            const name = await ask("Name of the share target on this machine", opts.target, "public");

            if (!name) {
                return fail("--target <name> is required for the client part");
            }

            await runTargetAdd(name, { driver: "paired", url: opts.url, code: opts.code, publicBase: opts.url });
        }
    } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
    }

    await out.flush();
}
