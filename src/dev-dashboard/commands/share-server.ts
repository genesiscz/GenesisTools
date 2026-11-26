import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pickShareTarget } from "@app/dev-dashboard/commands/share";
import {
    commandShareConfig,
    configureShareServer,
    type SetupServerOptions,
} from "@app/dev-dashboard/commands/share-server-setup";
import { runTargetAdd } from "@app/dev-dashboard/commands/share-target";
import { loadSharePublishConfig } from "@app/dev-dashboard/lib/share/legacy-share";
import { PUBLISH_KIND_SERVERS } from "@app/dev-dashboard/lib/share/server/kinds";
import {
    cloudflaredConfig,
    HOSTNAME_RE,
    startTunnelConnector,
    TUNNEL_NAME_RE,
    tunnelConfigPath,
    tunnelSetupSteps,
} from "@app/dev-dashboard/lib/share/server/tunnel";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { parseSince } from "@genesiscz/utils/date";
import { PairCodeResponseSchema } from "@genesiscz/utils/device-pairing/types";
import { env } from "@genesiscz/utils/env";
import { formatBytes, parseDuration } from "@genesiscz/utils/format";
import { freeDiskSpace } from "@genesiscz/utils/fs/disk-usage";
import { PUBLISH_KIND_IDS } from "@genesiscz/utils/genesis-tools/publish/kinds";
import { loadShareConfig, resolveServer, type ShareServerConfig } from "@genesiscz/utils/genesis-tools/publish/store";
import { shareServerServeCommand, shareServerSetupCommand } from "@genesiscz/utils/genesis-tools/tools/publish";
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
import { type AuditRecord, clientAuditDir, readAudit } from "@genesiscz/utils/publish/audit";
import { listenOrigin } from "@genesiscz/utils/publish/exposure";
import {
    ADMIN_SOCKET,
    adminRequest,
    DEFAULT_MIN_FREE_BYTES,
    parsePublicOrigin,
    type RunningPublishServer,
    serverOptionsFrom,
    startPublishServer,
} from "@genesiscz/utils/publish/server";
import { serviceFor } from "@genesiscz/utils/publish/service";
import { listSnapshotIds } from "@genesiscz/utils/publish/snapshot-store";
import { transportFor } from "@genesiscz/utils/publish/transports";
import { MissingSetupValueError, type TransportCheck } from "@genesiscz/utils/publish/transports/types";
import { toolDataDir } from "@genesiscz/utils/storage/root";
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
    server?: string;
    port?: number;
    host?: string;
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
    out.println(`On the client: ${shareServerSetupCommand("client", { url: publicBase, code })}`);
    await out.flush();
    return Date.parse(expiresAt);
}

export async function startShareServe(opts: ShareServerServeOptions = {}): Promise<{
    server: RunningPublishServer;
    stateDir: string;
    tunnel?: { name: string; configFile: string };
}> {
    const config = await loadShareConfig();
    const flags = {
        dataDir: opts.data,
        stateDir: opts.state,
        host: opts.host,
        port: opts.port,
        publicBase: opts.publicBase,
        minFreeGb: opts.minFreeGb,
        tunnel: opts.tunnel,
    };
    const legacy =
        opts.server === undefined &&
        config.servers.length === 0 &&
        Object.values(flags).some((value) => value !== undefined);
    const selected = legacy ? undefined : resolveServer(config, opts.server);
    const kinds = Object.values(PUBLISH_KIND_SERVERS);
    const fromConfig = selected ? serverOptionsFrom(selected, kinds) : undefined;
    const legacyDirs = shareServerDirs({});
    const host = opts.host ?? fromConfig?.host ?? "127.0.0.1";
    const port = opts.port ?? fromConfig?.port ?? SHARE_SERVER_PORT;
    const dataDir = opts.data ?? fromConfig?.dataDir ?? legacyDirs.dataDir;
    const stateDir = opts.state ?? fromConfig?.stateDir ?? legacyDirs.stateDir;
    const publicBase = parsePublicOrigin(
        opts.publicBase ?? fromConfig?.publicBase ?? listenOrigin(host, port),
        PUBLISH_KIND_IDS
    );
    const tunnel = opts.tunnel ?? (selected?.exposure.kind === "cloudflared" ? selected.exposure.tunnel : undefined);
    const configFile = tunnel ? tunnelConfigPath(stateDir, tunnel) : undefined;
    if (configFile && !existsSync(configFile)) {
        throw new Error(`No cloudflared config for tunnel "${tunnel}" at ${configFile}`);
    }

    const server = await startPublishServer({
        kinds: fromConfig?.kinds ?? kinds,
        legacyFlatKind: fromConfig ? fromConfig.legacyFlatKind : "md",
        dataDir,
        stateDir,
        publicBase,
        port,
        host,
        minFreeBytes: opts.minFreeGb === undefined ? fromConfig?.minFreeBytes : minFreeBytes(opts.minFreeGb),
    });
    const sources = Object.fromEntries(
        Object.entries(flags).map(([key, value]) => [
            key,
            value === undefined ? (selected ? "config" : "default") : "flag",
        ])
    );
    log.info({ server: selected?.name, sources, dataDir, stateDir, publicBase }, "publish server settings");
    return { server, stateDir, tunnel: tunnel && configFile ? { name: tunnel, configFile } : undefined };
}

export async function runShareServerServe(opts: ShareServerServeOptions): Promise<void> {
    let started: Awaited<ReturnType<typeof startShareServe>>;
    try {
        started = await startShareServe(opts);
    } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }

    const { server, stateDir, tunnel } = started;
    out.println(
        `Publish server at ${server.url} (public ${server.context.origin}, kinds ${[...server.context.kinds.keys()].join(", ")})`
    );
    if (opts.pair) {
        await printPairCode(stateDir, server.context.origin);
    }

    if (tunnel) {
        const connector = startTunnelConnector(tunnel);
        const code = await connector.exited;
        log.error({ code, tunnel: tunnel.name }, "the cloudflared connector exited");
        await server.stop();
        process.exit(code === 0 ? 1 : code);
    }

    await out.flush();
}

export interface ShareServerStatusOptions extends ShareServerPaths {
    server?: string;
    port?: number;
    publicBase?: string;
    minFreeGb?: number;
    json?: boolean;
}

export interface ShareServerStatusRow extends TransportCheck {
    server?: string;
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

async function serverStatusRows(
    opts: ShareServerStatusOptions,
    configured?: ShareServerConfig
): Promise<ShareServerStatusRow[]> {
    const bind = configured?.listen.host ?? "127.0.0.1";
    const host = bind === "0.0.0.0" ? "127.0.0.1" : bind === "::" || bind === "[::]" ? "::1" : bind;
    const origin = listenOrigin(host, opts.port ?? configured?.listen.port ?? SHARE_SERVER_PORT);
    const local = await probeHealth(origin);
    if (!local.answered && !configured) {
        return [];
    }

    const { dataDir, stateDir } = shareServerDirs({
        data: opts.data ?? configured?.dataDir,
        state: opts.state ?? configured?.stateDir,
    });
    const kinds = configured?.kinds ?? PUBLISH_KIND_IDS;
    const rows: ShareServerStatusRow[] = [
        { label: "Local port", ok: local.ours, detail: local.ours ? origin : local.detail },
        { label: "Local health", ok: hasKinds(local.kinds, kinds), detail: local.detail },
    ];

    const publicBase = opts.publicBase ?? configured?.publicOrigin;
    if (publicBase) {
        rows.push(
            await checkRow("Public health", async () => {
                const publicOrigin = parsePublicOrigin(publicBase, PUBLISH_KIND_IDS);
                const remote = await probeHealth(publicOrigin);
                const expected = local.kinds ?? kinds;
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

    const snapshots = kinds.map((kind) =>
        checkRow(`${kind} snapshots`, async () => {
            const ids = await listSnapshotIds({ dataDir, kind });
            return `${ids.length} in ${join(dataDir, kind)}`;
        })
    );
    const disk = checkRow("Free disk", () => {
        const available = freeDiskSpace(dataDir).available;
        const required = minFreeBytes(opts.minFreeGb ?? configured?.minFreeGb);
        const detail = `${formatBytes(available)} available, ${formatBytes(required)} required`;
        if (available < required) {
            throw new Error(detail);
        }

        return detail;
    });
    rows.push(...(await Promise.all([...snapshots, disk])));

    return rows;
}

function auditStatusRow(label: string, entry?: AuditRecord): ShareServerStatusRow[] {
    if (!entry) {
        return [];
    }

    const device = entry.deviceName ?? entry.deviceId;
    return [{ label, ok: true, detail: [entry.time, `HTTP ${entry.status}`, device].filter(Boolean).join(" · ") }];
}

const pairingAttempt = (entry: AuditRecord) => entry.action === "pair" || entry.action === "re-pair";
const failedAuth = (entry: AuditRecord) => entry.status === 401 || entry.status === 403;

async function serverAuditRows(stateDir: string): Promise<ShareServerStatusRow[]> {
    const [[pairing], [failed]] = await Promise.all([
        readAudit(stateDir, { limit: 1, accepts: pairingAttempt }),
        readAudit(stateDir, { limit: 1, accepts: (entry) => entry.action === "request" && failedAuth(entry) }),
    ]);
    return [...auditStatusRow("Last pairing attempt", pairing), ...auditStatusRow("Last failed token check", failed)];
}

async function configuredRows(
    server: ShareServerConfig,
    opts: ShareServerStatusOptions = {}
): Promise<ShareServerStatusRow[]> {
    const active = server.service.manager === "none" || (await serviceFor(server).isActive(server));
    const service = { label: "Service", ok: active, detail: server.service.manager };
    const rows = await serverStatusRows(opts, server);
    const audit = await serverAuditRows(opts.state ?? server.stateDir);
    return [service, ...rows, ...audit].map((row) => ({ ...row, server: server.name }));
}

export async function collectShareServerStatus(opts: ShareServerStatusOptions = {}): Promise<ShareServerStatusRow[]> {
    const [local, clients] = await Promise.all([commandShareConfig(opts.server), loadSharePublishConfig()]);
    const selected = opts.server ? [resolveServer(local, opts.server)] : local.servers;
    const servers = selected.length
        ? (await Promise.all(selected.map((server) => configuredRows(server, opts)))).flat()
        : await serverStatusRows(opts);
    const targets = await Promise.all(
        clients.targets.map(async (target) => {
            const checks = await transportFor(target).check(target);
            const [[pairing], [failed]] = await Promise.all([
                readAudit(clientAuditDir(), {
                    limit: 1,
                    accepts: (entry) => entry.target === target.name && pairingAttempt(entry),
                }),
                readAudit(clientAuditDir(), {
                    limit: 1,
                    accepts: (entry) =>
                        entry.target === target.name &&
                        (entry.action === "token-read" || entry.action === "token-check") &&
                        entry.status >= 400,
                }),
            ]);
            return [
                ...checks,
                ...auditStatusRow("Last pairing attempt", pairing),
                ...auditStatusRow("Last failed token check", failed),
            ].map((row) => ({ ...row, target: target.name }));
        })
    );
    return [...servers, ...targets.flat()];
}

function printStatus(rows: ShareServerStatusRow[], json = false): void {
    if (json) {
        out.result(rows);
    } else {
        out.println(
            formatTable(
                rows.map(({ target, server, label, ok, detail }) => [
                    target ?? server ?? "server",
                    label,
                    ok ? "ok" : "failed",
                    detail,
                ]),
                ["Target", "Check", "Status", "Detail"],
                { maxColWidth: 120 }
            )
        );
    }
}

export async function runShareServerAudit(
    opts: { server?: string; client?: boolean; since?: string; device?: string; json?: boolean } = {}
): Promise<void> {
    if (opts.client && opts.server) {
        throw new Error("Choose either --client or --server.");
    }

    const relative = opts.since ? parseDuration(opts.since) : 0;
    const since = opts.since ? (relative > 0 ? new Date(Date.now() - relative) : parseSince(opts.since)) : undefined;
    if (opts.since !== undefined && (!since || !Number.isFinite(since.getTime()))) {
        throw new Error("Invalid --since value. Use an ISO time or a duration such as 7d.");
    }

    const config = opts.client ? undefined : await commandShareConfig(opts.server);
    const dir =
        config && (opts.server || config.servers.length)
            ? resolveServer(config, opts.server).stateDir
            : clientAuditDir();
    const records = await readAudit(dir, { since: since ?? undefined, device: opts.device });
    if (opts.json) {
        out.result(records);
    } else {
        out.println(
            formatTable(
                records.map((row) => [
                    row.time,
                    row.side,
                    row.address ?? "",
                    row.action,
                    [row.method, row.path].filter(Boolean).join(" "),
                    row.target ?? "",
                    [row.kind, row.id].filter(Boolean).join("/"),
                    row.deviceId ?? "",
                    String(row.status),
                    String(row.bytesOut ?? ""),
                    String(row.durationMs),
                    row.userAgent ?? "",
                ]),
                [
                    "Time",
                    "Side",
                    "Address",
                    "Action",
                    "Request",
                    "Target",
                    "Snapshot",
                    "Device",
                    "Status",
                    "Bytes",
                    "ms",
                    "User agent",
                ],
                { maxColWidth: 60 }
            )
        );
    }

    await out.flush();
}

export async function runShareServerStatus(opts: ShareServerStatusOptions): Promise<void> {
    const rows = await collectShareServerStatus(opts);
    printStatus(rows, opts.json);
    if (rows.some((row) => !row.ok)) {
        process.exitCode = 1;
    }

    await out.flush();
}

interface ShareServerAdminOptions extends ShareServerPaths {
    server?: string;
    publicBase?: string;
}

export async function runShareServerPair(opts: ShareServerAdminOptions): Promise<void> {
    try {
        const config = await commandShareConfig(opts.server);
        const selected = config.servers.length || opts.server ? resolveServer(config, opts.server) : undefined;
        const state = opts.state ?? selected?.stateDir;
        if (!state) {
            throw new Error(`Set up a server with ${shareServerSetupCommand("server")}`);
        }

        const base = opts.publicBase ?? selected?.publicOrigin ?? "https://share.example.com";
        await printPairCode(state, parsePublicOrigin(base, PUBLISH_KIND_IDS));
    } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
    }

    await out.flush();
}

export async function runShareServerDevices(opts: ShareServerAdminOptions & { revoke?: string }): Promise<void> {
    try {
        const [config, client] = await Promise.all([commandShareConfig(opts.server), loadSharePublishConfig()]);
        const selected =
            opts.server || (opts.revoke && config.servers.length)
                ? [resolveServer(config, opts.server)]
                : config.servers;
        if (opts.revoke) {
            const stateDir = opts.state ?? selected[0]?.stateDir;
            if (!stateDir) {
                throw new Error("Choose a configured server with --server.");
            }

            await adminRequest({ stateDir, path: ADMIN_API.device(opts.revoke), method: "DELETE" });
            out.println(`Revoked ${opts.revoke}`);
        } else {
            const servers = selected.length
                ? selected.map(({ name, stateDir }) => ({ name, stateDir }))
                : opts.state
                  ? [{ name: "server", stateDir: opts.state }]
                  : [];
            for (const { name, stateDir } of servers) {
                for (const device of await readDevices(stateDir)) {
                    out.println(
                        `${name}\t${device.id}\t${device.name}\tpaired ${device.createdAt}\tlast used ${device.lastUsedAt ?? "never"}`
                    );
                }
            }

            for (const { name, transport } of client.targets) {
                if (transport.kind === "paired") {
                    out.println(
                        `Target ${name}\t${transport.deviceId}\t${transport.url}\tpaired ${transport.pairedAt ?? "unknown"}`
                    );
                }
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

export async function runShareServerUnit(
    opts: ShareServerPaths & { server?: string; root: string; bun: string }
): Promise<void> {
    const server = resolveServer(await commandShareConfig(opts.server), opts.server);
    const adjusted = { ...server, dataDir: opts.data ?? server.dataDir, stateDir: opts.state ?? server.stateDir };
    const config = { server: adjusted, checkoutDir: opts.root, bunPath: opts.bun, home: env.tools.getHome() };
    out.print(serviceFor(server).render(config));
    await out.flush();
}

export async function runShareServerService(action: "up" | "down", opts: { server?: string } = {}): Promise<void> {
    try {
        const server = resolveServer(await commandShareConfig(opts.server), opts.server);
        const installer = serviceFor(server);
        if (action === "up" && installer.manager === "none") {
            out.println(shareServerServeCommand(server.name));
        } else {
            await (action === "up" ? installer.restart(server) : installer.stop(server));
            out.println(`${server.name} ${action === "up" ? "restarted" : "stopped"}`);
        }
    } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
    }

    await out.flush();
}

export const SHARE_SETUP_MODES = ["server", "client", "both"] as const;
export type ShareSetupMode = (typeof SHARE_SETUP_MODES)[number];

interface ShareServerSetupOptions extends SetupServerOptions, ShareServerPaths {
    role?: string;
    mode?: string;
    publicBase?: string;
    user?: string;
    pair?: boolean;
    target?: string | true;
    url?: string;
    code?: string;
    default?: boolean;
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

function setupSuggestion(opts: ShareServerSetupOptions, flag: string): string {
    const known = {
        role: opts.role ?? opts.mode,
        server: opts.server,
        target: typeof opts.target === "string" ? opts.target : undefined,
        "public-origin": opts.publicOrigin ?? opts.publicBase,
        port: opts.port,
        host: opts.host,
        "data-dir": opts.dataDir ?? opts.data,
        "state-dir": opts.stateDir ?? opts.state,
        exposure: opts.exposure,
        proxy: opts.proxy,
        tunnel: opts.tunnel,
        service: opts.service,
        "service-user": opts.serviceUser ?? opts.user,
        url: opts.url,
        code: opts.code,
        "adopt-unit": opts.adoptUnit,
    };
    const args = ["setup"];
    for (const [key, value] of Object.entries(known)) {
        if (value !== undefined) {
            args.push(`--${key}`, String(value));
        }
    }

    if (opts.yes || flag === "yes") {
        args.push("--yes");
    } else if (!Object.hasOwn(known, flag) || known[flag as keyof typeof known] === undefined) {
        args.push(`--${flag}`, `<${flag}>`);
    }

    return suggestCommand(TOOL, { replaceCommand: args });
}

async function setupClient(opts: ShareServerSetupOptions, interactive: boolean): Promise<void> {
    const ask = async (flag: string, label: string, given?: string): Promise<string> => {
        if (given?.trim()) {
            return given.trim();
        }
        if (!interactive) {
            throw new MissingSetupValueError(flag);
        }

        return p.text({ message: label });
    };
    const url = await ask("url", "Publish server URL [https://share.example.com]", opts.url);
    const code = await ask("code", "One-time code [from the server]", opts.code);
    const config = await loadSharePublishConfig();
    const origin = new URL(url);
    const already = config.targets.find(
        ({ transport }) => transport.kind === "paired" && transport.url === origin.origin
    );
    const initial =
        already?.name ??
        (origin.hostname
            .split(".")[0]
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "")
            .slice(0, 32) ||
            "server");
    const name =
        opts.target === true
            ? await pickShareTarget({
                  given: true,
                  candidates: [...new Set([initial, ...config.targets.map(({ name }) => name)])],
                  subcommand: ["share-server", "setup", "--role", "client", "--url", url, "--code", code],
                  all: false,
              })
            : (opts.target ??
              (interactive ? await p.text({ message: `Target name [${initial}]`, initialValue: initial }) : initial));
    if (!name) {
        return;
    }
    const defaultValue = !config.defaults.target || config.defaults.target === name;
    const makeDefault =
        opts.default ??
        (interactive
            ? await p.confirm({
                  message: `Make this the default target? [${defaultValue ? "yes" : "no"}]`,
                  initialValue: defaultValue,
              })
            : defaultValue);

    await runTargetAdd(name, { driver: "paired", url, code, default: makeDefault, replace: true });
}

export async function runShareServerSetup(opts: ShareServerSetupOptions): Promise<void> {
    const interactive = isInteractive() && !opts.yes;
    try {
        const requested = opts.role ?? opts.mode;
        const role = requested
            ? SHARE_SETUP_MODES.find((choice) => choice === requested)
            : interactive
              ? await p.select({
                    message: "What should this computer do? [both]",
                    initialValue: "both",
                    options: SHARE_SETUP_MODES.map((value) => ({ value, label: value })),
                })
              : undefined;
        if (!role) {
            throw new MissingSetupValueError("role");
        }

        if (role !== "client") {
            const { server } = await configureShareServer(
                {
                    ...opts,
                    publicOrigin: opts.publicOrigin ?? opts.publicBase,
                    dataDir: opts.dataDir ?? opts.data,
                    stateDir: opts.stateDir ?? opts.state,
                    serviceUser: opts.serviceUser ?? opts.user,
                },
                {
                    prepareExposure: async (entry) => {
                        if (
                            entry.exposure.kind === "cloudflared" &&
                            !existsSync(tunnelConfigPath(entry.stateDir, entry.exposure.tunnel))
                        ) {
                            await runShareServerTunnel({
                                name: entry.exposure.tunnel,
                                state: entry.stateDir,
                                hostname: new URL(entry.publicOrigin).hostname,
                                port: entry.listen.port,
                            });
                            if (!existsSync(tunnelConfigPath(entry.stateDir, entry.exposure.tunnel))) {
                                throw new Error(
                                    `Finish the tunnel setup, then run ${shareServerSetupCommand("server", { server: entry.name })}`
                                );
                            }
                        }
                    },
                }
            );
            const rows = await configuredRows(server);
            printStatus(rows);
            if (rows.some(({ ok }) => !ok)) {
                if (server.service.manager === "none") {
                    out.println(`Start the listener with ${shareServerServeCommand(server.name)}`);
                }

                fail(
                    "Fix the failed checks and run setup again.",
                    shareServerSetupCommand("server", { server: server.name })
                );
            } else if (opts.pair || interactive) {
                await offerPairing(server.stateDir, server.publicOrigin, opts.pair);
            }
        }

        if (role !== "server") {
            await setupClient(opts, interactive);
        }
    } catch (err) {
        if (err instanceof MissingSetupValueError) {
            fail(err.message, setupSuggestion(opts, err.flag));
        } else {
            fail(err instanceof Error ? err.message : String(err));
        }
    }

    await out.flush();
}
