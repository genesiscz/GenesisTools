import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runTargetAdd } from "@app/dev-dashboard/commands/share-target";
import { importLegacyShare, loadSharePublishConfig } from "@app/dev-dashboard/lib/share/legacy-share";
import { PUBLISH_KIND_SERVERS } from "@app/dev-dashboard/lib/share/server/kinds";
import {
    cloudflaredConfig,
    HOSTNAME_RE,
    startTunnelConnector,
    TUNNEL_NAME_RE,
    tunnelConfigPath,
    tunnelSetupSteps,
} from "@app/dev-dashboard/lib/share/server/tunnel";
import { Executor, isInteractive, suggestCommand, suggestEnumFlag } from "@genesiscz/utils/cli";
import { PairCodeResponseSchema } from "@genesiscz/utils/device-pairing/types";
import { formatBytes } from "@genesiscz/utils/format";
import { freeDiskSpace } from "@genesiscz/utils/fs/disk-usage";
import { PUBLISH_KIND_IDS } from "@genesiscz/utils/genesis-tools/publish/kinds";
import { shareServerSetupCommand, shareTargetAddCommand } from "@genesiscz/utils/genesis-tools/tools/publish";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import {
    ADMIN_API,
    DeviceListSchema,
    HealthSchema,
    PUBLISH_API,
    PUBLISH_SERVER_HEADER,
    PUBLISH_SERVER_ID,
} from "@genesiscz/utils/publish/api";
import {
    ADMIN_SOCKET,
    adminRequest,
    DEFAULT_MIN_FREE_BYTES,
    parsePublicOrigin,
    startPublishServer,
} from "@genesiscz/utils/publish/server";
import { listSnapshotIds } from "@genesiscz/utils/publish/snapshot-store";
import { transportFor } from "@genesiscz/utils/publish/transports";
import type { TransportCheck } from "@genesiscz/utils/publish/transports/types";
import { genesisToolsDirIn, toolDataDir } from "@genesiscz/utils/storage/root";
import { formatTable } from "@genesiscz/utils/table";
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
    minFreeGb?: number;
}

function fail(message: string, suggestion?: string): void {
    out.error(message);

    if (suggestion) {
        out.printlnErr(suggestion);
    }

    process.exitCode = 1;
}

async function printPairCode(stateDir: string, publicBase: string): Promise<number> {
    const { code, expiresAt } = PairCodeResponseSchema.parse(
        await adminRequest({ stateDir, path: ADMIN_API.pairCode, method: "POST" })
    );
    out.println(`pairing code: ${code} (valid until ${new Date(expiresAt).toLocaleString()})`);
    out.println(`On the client: ${shareTargetAddCommand({ url: publicBase, code })}`);
    await out.flush();
    return Date.parse(expiresAt);
}

/** `share-server serve`: run the share server in the foreground (what the service unit runs). */
export async function runShareServerServe(opts: ShareServerServeOptions): Promise<void> {
    const { dataDir, stateDir } = shareServerDirs(opts);
    const publicBase = opts.publicBase ?? `http://${opts.host}:${opts.port}`;

    try {
        parsePublicOrigin(publicBase, PUBLISH_KIND_IDS);
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

    const server = await startPublishServer({
        kinds: Object.values(PUBLISH_KIND_SERVERS),
        legacyFlatKind: "md",
        dataDir,
        stateDir,
        publicBase,
        port: opts.port,
        host: opts.host,
        minFreeBytes: minFreeBytes(opts.minFreeGb),
    });
    out.println(
        `Publish server on ${server.url} (data ${dataDir}, public ${server.context.origin}; kinds ${PUBLISH_KIND_IDS.join(", ")})`
    );

    if (opts.pair) {
        await printPairCode(stateDir, server.context.origin);
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

export interface ShareServerStatusOptions extends ShareServerPaths {
    port: number;
    publicBase?: string;
    minFreeGb?: number;
    json?: boolean;
}

export interface ShareServerStatusRow extends TransportCheck {
    target?: string;
}

interface HealthProbe {
    answered: boolean;
    ours: boolean;
    kinds?: string[];
    detail: string;
}

function minFreeBytes(gb: number | undefined): number {
    return gb === undefined ? DEFAULT_MIN_FREE_BYTES : Math.ceil(gb * 1024 ** 3);
}

async function probeHealth(origin: string): Promise<HealthProbe> {
    const url = new URL(PUBLISH_API.health, origin);
    let response: Response;
    try {
        response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
    } catch (err) {
        log.debug({ err, url: url.href }, "publish server did not answer");
        return { answered: false, ours: false, detail: `${origin} did not answer` };
    }

    const ours = response.headers.get(PUBLISH_SERVER_HEADER) === PUBLISH_SERVER_ID;
    if (!response.ok || !ours) {
        await response.body?.cancel();
        const detail =
            ours && response.status === 404
                ? `Health route missing. Update with ${shareServerSetupCommand("server")}.`
                : `${url.href} returned HTTP ${response.status}${ours ? "" : " without the publish server header"}`;
        return { answered: true, ours, detail };
    }

    try {
        const health = HealthSchema.parse(await response.json());
        return { answered: true, ours, kinds: health.kinds, detail: health.kinds.join(", ") };
    } catch (err) {
        log.debug({ err, url: url.href }, "publish health response rejected");
        return { answered: true, ours, detail: "Invalid publish health response" };
    }
}

function hasKinds(got: string[] | undefined, expected: readonly string[]): boolean {
    return got !== undefined && expected.every((kind) => got.includes(kind));
}

async function checkRow(label: string, check: () => Promise<string> | string): Promise<ShareServerStatusRow> {
    try {
        return { label, ok: true, detail: await check() };
    } catch (err) {
        log.debug({ err, label }, "publish server check failed");
        return { label, ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
}

async function readDevices(stateDir: string) {
    return DeviceListSchema.parse(await adminRequest({ stateDir, path: ADMIN_API.devices })).devices;
}

async function serverStatusRows(opts: ShareServerStatusOptions): Promise<ShareServerStatusRow[]> {
    const origin = `http://127.0.0.1:${opts.port}`;
    const local = await probeHealth(origin);
    if (!local.answered && !existsSync(UNIT_PATH)) {
        return [];
    }

    const { dataDir, stateDir } = shareServerDirs(opts);
    const rows: ShareServerStatusRow[] = [
        { label: "Local port", ok: local.ours, detail: local.ours ? origin : local.detail },
        { label: "Local health", ok: hasKinds(local.kinds, PUBLISH_KIND_IDS), detail: local.detail },
    ];

    if (opts.publicBase) {
        const publicBase = opts.publicBase;
        rows.push(
            await checkRow("Public health", async () => {
                const publicOrigin = parsePublicOrigin(publicBase, PUBLISH_KIND_IDS);
                const remote = await probeHealth(publicOrigin);
                const expected = local.kinds ?? PUBLISH_KIND_IDS;
                if (!hasKinds(remote.kinds, expected) || remote.kinds?.length !== expected.length) {
                    throw new Error(
                        remote.kinds
                            ? `${publicOrigin} serves ${remote.detail}; expected ${expected.join(", ")}`
                            : remote.detail
                    );
                }

                return `${publicOrigin} serves ${remote.detail}`;
            })
        );
    }

    let deviceCount: number | undefined;
    rows.push(
        await checkRow("Admin socket", async () => {
            deviceCount = (await readDevices(stateDir)).length;
            return join(stateDir, ADMIN_SOCKET);
        })
    );
    rows.push({
        label: "Paired devices",
        ok: deviceCount !== undefined,
        detail: deviceCount === undefined ? "Device count unavailable" : String(deviceCount),
    });

    const snapshots = PUBLISH_KIND_IDS.map((kind) =>
        checkRow(`${kind} snapshots`, async () => {
            const ids = await listSnapshotIds({ dataDir, kind });
            return `${ids.length} in ${join(dataDir, kind)}`;
        })
    );
    const disk = checkRow("Free disk", () => {
        const available = freeDiskSpace(dataDir).available;
        const required = minFreeBytes(opts.minFreeGb);
        const detail = `${formatBytes(available)} available, ${formatBytes(required)} required`;
        if (available < required) {
            throw new Error(detail);
        }

        return detail;
    });
    rows.push(...(await Promise.all([...snapshots, disk])));

    return rows;
}

export async function collectShareServerStatus(opts: ShareServerStatusOptions): Promise<ShareServerStatusRow[]> {
    const [server, config] = await Promise.all([serverStatusRows(opts), loadSharePublishConfig()]);
    const clients = await Promise.all(
        config.client.targets.map(async (target) => {
            const rows = await transportFor(target).check(target);
            return rows.map((row) => ({ ...row, target: target.name }));
        })
    );
    return [...server, ...clients.flat()];
}

function printStatus(rows: ShareServerStatusRow[], json = false): void {
    if (json) {
        out.result(rows);
    } else {
        out.println(
            formatTable(
                rows.map(({ target, label, ok, detail }) => [target ?? "server", label, ok ? "ok" : "failed", detail]),
                ["Target", "Check", "Status", "Detail"],
                { maxColWidth: 120 }
            )
        );
    }
}

export async function runShareServerStatus(opts: ShareServerStatusOptions): Promise<void> {
    const rows = await collectShareServerStatus(opts);
    printStatus(rows, opts.json);
    if (rows.some((row) => !row.ok)) {
        process.exitCode = 1;
    }

    await out.flush();
}

export async function runShareServerPair(opts: ShareServerPaths & { publicBase?: string }): Promise<void> {
    const { stateDir } = shareServerDirs(opts);

    try {
        await printPairCode(
            stateDir,
            opts.publicBase ? parsePublicOrigin(opts.publicBase, PUBLISH_KIND_IDS) : "https://share.example.com"
        );
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

async function startInstalledService(): Promise<boolean> {
    return (await systemctl(["enable", SHARE_SERVER_SERVICE])) && systemctl(["restart", SHARE_SERVER_SERVICE]);
}

/** `share-server up` enables and restarts. `down` disables and stops. */
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

    const ok =
        action === "up" ? await startInstalledService() : await systemctl(["disable", "--now", SHARE_SERVER_SERVICE]);

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

async function offerPairing(stateDir: string, publicBase: string, pairNow?: boolean): Promise<void> {
    if (!isInteractive()) {
        if (pairNow) {
            await printPairCode(stateDir, publicBase);
        }

        return;
    }

    let confirmed = pairNow ?? (await p.confirm({ message: "Pair a computer with this server now?" }));
    while (confirmed) {
        const known = new Set((await readDevices(stateDir)).map(({ id }) => id));
        const expiresAt = await printPairCode(stateDir, publicBase);
        let name: string | undefined;

        while (Date.now() < expiresAt) {
            await Bun.sleep(Math.min(2000, Math.max(0, expiresAt - Date.now())));
            const device = (await readDevices(stateDir)).find(({ id }) => !known.has(id));
            if (device) {
                name = device.name;
                break;
            }
        }

        out.println(name ? `Paired ${name}` : "The pairing code expired.");
        confirmed = await p.confirm({ message: "Pair a computer with this server now?" });
    }
}

async function setupServer(opts: ShareServerSetupOptions): Promise<boolean> {
    const publicBase = await ask("Public origin of the pages (e.g. https://share.example.com)", opts.publicBase);
    if (!publicBase) {
        fail(
            "--public-base is required",
            suggestCommand(TOOL, {
                replaceCommand: ["setup", "--mode", "server", "--public-base", "https://share.example.com"],
            })
        );
        return false;
    }

    const origin = parsePublicOrigin(publicBase, PUBLISH_KIND_IDS);
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
    const installed = await readFile(UNIT_PATH, "utf8").catch((err: unknown) => {
        log.debug({ err, unit: UNIT_PATH }, "could not read the installed service unit");
        return null;
    });
    out.println(
        `unit ${UNIT_PATH}: ${installed === null ? "not installed" : installed === unit ? "up to date" : "differs from this setup"}`
    );

    if (installed !== unit) {
        const canWrite = hasSystemd() && process.getuid?.() === 0 && isInteractive();
        if (canWrite && (await p.confirm({ message: `Write ${UNIT_PATH} and restart the service?` }))) {
            for (const [dir, mode] of [
                [dataDir, "0755"],
                [stateDir, "0700"],
            ]) {
                if (
                    !existsSync(dir) &&
                    !(await runStep(["install", "-d", "-m", mode, "-o", opts.user, "-g", opts.user, "--", dir]))
                ) {
                    return false;
                }
            }

            await writeFile(UNIT_PATH, unit);
            if (!(await systemctl(["daemon-reload"])) || !(await startInstalledService())) {
                return false;
            }
        } else {
            out.println("Install this unit with your host's config management, then run share-server up.");
            out.print(unit);
        }
    }

    const rows = await collectShareServerStatus({ ...opts, publicBase: origin });
    printStatus(rows);
    const admin = rows.find((row) => !row.target && row.label === "Admin socket");
    if (opts.pair || admin?.ok) {
        await offerPairing(stateDir, origin, opts.pair);
    }

    return rows.every(({ ok }) => ok);
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
        await importLegacyShare();
        if (mode !== "client" && !(await setupServer(opts))) {
            process.exitCode = 1;
            return;
        }

        if (mode !== "server") {
            const name = await ask("Name of the share target on this machine", opts.target, "public");

            if (!name) {
                return fail("--target <name> is required for the client part");
            }

            await runTargetAdd(name, { driver: "paired", url: opts.url, code: opts.code, replace: true });
        }
    } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
    }

    await out.flush();
}
