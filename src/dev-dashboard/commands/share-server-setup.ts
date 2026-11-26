import { constants, existsSync } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Executor, isInteractive, suggestEnumFlag } from "@genesiscz/utils/cli";
import { env } from "@genesiscz/utils/env";
import { isMissingPathError } from "@genesiscz/utils/fs/canonical";
import { PUBLISH_KIND_IDS } from "@genesiscz/utils/genesis-tools/publish/kinds";
import {
    loadShareConfigForHome,
    type ServiceManager,
    type ShareConfig,
    type ShareServerConfig,
    ShareServerConfigSchema,
    shareConfigPath,
    updateShareConfigForHome,
} from "@genesiscz/utils/genesis-tools/publish/store";
import { logger, out } from "@genesiscz/utils/logger";
import { PROJECT_ROOT } from "@genesiscz/utils/paths";
import * as p from "@genesiscz/utils/prompts/p";
import { HealthSchema, PUBLISH_API, PUBLISH_SERVER_HEADER, PUBLISH_SERVER_ID } from "@genesiscz/utils/publish/api";
import { listenOrigin, proxySnippet } from "@genesiscz/utils/publish/exposure";
import { parsePublicOrigin } from "@genesiscz/utils/publish/server";
import { serviceFor } from "@genesiscz/utils/publish/service";
import { SYSTEMD_UNITS, stagedSystemdUnit, withStagedSystemdUnit } from "@genesiscz/utils/publish/service/systemd";
import {
    runServiceCommand,
    type ServiceInstaller,
    type ServiceRunner,
    type ServiceUnitInput,
    writeServiceFile,
} from "@genesiscz/utils/publish/service/types";
import { TARGET_NAME_RE } from "@genesiscz/utils/publish/targets";
import { MissingSetupValueError } from "@genesiscz/utils/publish/transports/types";
import { shellCommandLine } from "@genesiscz/utils/shell/quote";
import { shellWordSpans } from "@genesiscz/utils/shell/words";
import { genesisToolsDirIn } from "@genesiscz/utils/storage/root";
import { WEB_SERVICES } from "@genesiscz/utils/ui/dashboards";

const DEFAULT_PORT = WEB_SERVICES["dev-dashboard-share-server"].port;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_UNIT = "genesis-share-server.service";
const managers = ["systemd", "launchd", "none"] as const;
const exposures = ["reverse-proxy", "cloudflared", "local"] as const;
const proxies = ["apache", "nginx", "caddy", "other"] as const;
const proxyLocations = {
    apache: "the site's VirtualHost, usually under /etc/apache2/sites-available",
    nginx: "the site's server block, usually under /etc/nginx/sites-available",
    caddy: "the Caddyfile, usually /etc/caddy/Caddyfile",
    other: "your reverse proxy's routing configuration",
} as const;

export interface SetupServerOptions {
    server?: string;
    configHome?: string;
    yes?: boolean;
    publicOrigin?: string;
    port?: number;
    host?: string;
    dataDir?: string;
    stateDir?: string;
    exposure?: string | true;
    proxy?: string | true;
    tunnel?: string;
    service?: string | true;
    serviceUser?: string;
    adoptUnit?: string;
    root?: string;
    bun?: string;
}

interface ServiceAccount {
    name: string;
    uid: number;
    gid: number;
    home: string;
}

export interface SetupServerDeps {
    interactive: boolean;
    platform: NodeJS.Platform;
    account: ServiceAccount;
    installer(server: ShareServerConfig): ServiceInstaller;
    runSystemCommand?: ServiceRunner;
    prepareExposure?(server: ShareServerConfig): Promise<void>;
    waitUntilReady?(server: ShareServerConfig): Promise<void>;
}

const passwd = new Executor({ label: "publish-service-account" });

export async function lookupAccount(name: string): Promise<ServiceAccount | undefined> {
    if (!/^[a-z_][a-z0-9_-]*$/.test(name)) {
        throw new Error("Enter a valid non-root service user");
    }

    const result = await passwd.exec(["getent", "passwd", name], {
        timeout: { ms: 5000, reason: "resolve the service account" },
    });
    if (!result.success) {
        return undefined;
    }

    const [user, , uid, gid, , home] = result.stdout.trim().split(":");
    if (user !== name || !home?.startsWith("/") || !Number.isInteger(Number(uid)) || !Number.isInteger(Number(gid))) {
        throw new Error(`Invalid account record for ${name}`);
    }

    return { name, uid: Number(uid), gid: Number(gid), home };
}

export async function commandShareConfig(input: { server?: string; configHome?: string } = {}): Promise<ShareConfig> {
    const { server: name, configHome } = input;
    if (configHome) {
        return loadShareConfigForHome(configHome);
    }

    const local = await loadShareConfigForHome();
    if (
        (name ? local.servers.some((server) => server.name === name) : local.servers.length > 0) ||
        env.get("GENESIS_TOOLS_HOME") ||
        process.platform !== "linux" ||
        process.getuid?.() !== 0
    ) {
        return local;
    }

    const account = await lookupAccount("genesis-share");
    if (!account || account.uid === 0) {
        return local;
    }

    const service = await loadShareConfigForHome(account.home);
    return !name || service.servers.some((entry) => entry.name === name) ? service : local;
}

function defaultDeps(): SetupServerDeps {
    const { username, uid, gid } = userInfo();
    return {
        interactive: isInteractive(),
        platform: process.platform,
        account: { name: username, uid, gid, home: env.tools.getHome() },
        installer: serviceFor,
    };
}

export function parseLegacyShareUnit(input: {
    text: string;
    name: string;
    path: string;
}): ShareServerConfig | undefined {
    const exec = /^ExecStart\s*=\s*(.+)$/m.exec(input.text)?.[1];
    const argv = exec ? shellWordSpans(exec).map(({ value }) => value) : [];
    const offset = argv.findIndex((word, index) => word === "share-server" && argv[index + 1] === "serve");
    if (offset < 0 || argv.slice(offset + 2).some((word) => word === "--server" || word.startsWith("--server="))) {
        return undefined;
    }

    const flags = new Map<string, string>();
    for (let i = offset + 2; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith("--")) {
            continue;
        }

        const equals = arg.indexOf("=");
        if (equals >= 0) {
            flags.set(arg.slice(2, equals), arg.slice(equals + 1));
        } else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
            flags.set(arg.slice(2), argv[++i]);
        }
    }

    const user = /^User\s*=\s*([0-9A-Za-z_-]+)\s*$/m.exec(input.text)?.[1];
    const defaultPort = Number(flags.get("port") ?? DEFAULT_PORT);
    const host = flags.get("host") ?? DEFAULT_HOST;
    const base = flags.get("public-base") ?? listenOrigin(host, defaultPort);
    return ShareServerConfigSchema.parse({
        name: input.name,
        dataDir: flags.get("data"),
        stateDir: flags.get("state"),
        listen: { host, port: defaultPort },
        publicOrigin: parsePublicOrigin(base, PUBLISH_KIND_IDS),
        kinds: PUBLISH_KIND_IDS,
        minFreeGb: Number(flags.get("min-free-gb") ?? 2),
        exposure: flags.has("tunnel")
            ? { kind: "cloudflared", tunnel: flags.get("tunnel") }
            : { kind: "reverse-proxy", proxy: "apache" },
        service: { manager: "systemd", unit: basename(input.path), user },
    });
}

async function findLegacyUnit(input: {
    path?: string;
    name: string;
    adoptAutomatically: boolean;
    interactive: boolean;
}) {
    const { path, name, adoptAutomatically, interactive } = input;
    const candidate = path ?? join(SYSTEMD_UNITS, name === "default" ? DEFAULT_UNIT : `genesis-share-${name}.service`);
    const text = await readFile(candidate, "utf8").catch((err: unknown) => {
        if (!path && isMissingPathError(err)) {
            return null;
        }

        throw err;
    });
    const server = text && parseLegacyShareUnit({ text, name, path: candidate });
    if (!server) {
        if (path) {
            throw new Error(`No flag-based share server found in ${path}`);
        }

        return undefined;
    }

    const allowed =
        adoptAutomatically ||
        (interactive &&
            (await p.confirm({
                message: `Adopt the existing service in ${candidate}? [yes]`,
                initialValue: true,
            })));
    if (!allowed) {
        throw new Error(`Adoption declined for ${candidate}. Choose a different server name to keep that unit.`);
    }

    return { server, path: candidate, text: text ?? "" };
}

async function textValue(
    interactive: boolean,
    message: string,
    given: string | undefined,
    initial: string
): Promise<string> {
    return given ?? (interactive ? p.text({ message: `${message} [${initial}]`, initialValue: initial }) : initial);
}

async function choice<T extends string>(input: {
    flag: string;
    value?: string | true;
    initial: T;
    choices: readonly T[];
    interactive: boolean;
    label: string;
}): Promise<T> {
    const { flag, value, initial, choices, interactive, label } = input;
    if (value === true && interactive) {
        return p.select({
            message: label,
            initialValue: initial,
            options: choices.map((entry) => ({ value: entry, label: entry })),
        });
    }

    if (value !== undefined) {
        const match = choices.find((entry) => entry === value);
        if (!match) {
            throw new Error(suggestEnumFlag("tools dev-dashboard share-server setup", `--${flag}`, choices));
        }

        return match;
    }

    return interactive
        ? p.select({
              message: `${label} [${initial}]`,
              initialValue: initial,
              options: choices.map((entry) => ({ value: entry, label: entry })),
          })
        : initial;
}

async function serviceAccount(
    deps: SetupServerDeps,
    manager: ServiceManager,
    serviceUser?: string
): Promise<ServiceAccount> {
    if (manager !== "systemd" || deps.account.uid !== 0) {
        if (manager === "systemd" && serviceUser && serviceUser !== deps.account.name) {
            throw new Error("Run setup as root to select another service user.");
        }

        return deps.account;
    }

    const name = await textValue(deps.interactive, "Service user", serviceUser, "genesis-share");
    if (name === "root") {
        throw new Error("Choose a non-root service user.");
    }

    let account = await lookupAccount(name);
    if (!account) {
        await runServiceCommand(["useradd", "--system", "--create-home", name]);
        account = await lookupAccount(name);
    }

    if (!account || account.uid === 0) {
        throw new Error(`Cannot use ${name} as the publish service user`);
    }

    return account;
}

function defaultManager(platform: NodeJS.Platform): ServiceManager {
    if (platform === "linux") {
        return "systemd";
    }

    return platform === "darwin" ? "launchd" : "none";
}

export async function moveAdoptedShareFolders(
    previous: ShareServerConfig,
    next: ShareServerConfig
): Promise<() => Promise<void>> {
    const moves = [
        [previous.dataDir, next.dataDir],
        [previous.stateDir, next.stateDir],
    ].filter(([from, to]) => from !== to);
    for (const [from, to] of moves) {
        if (!existsSync(from) || existsSync(to)) {
            throw new Error(`Cannot move ${from} to ${to}. The source must exist and the destination must be vacant.`);
        }
    }

    const completed: Array<[string, string]> = [];
    const undo = async () => {
        for (const [from, to] of completed.reverse()) {
            await rename(to, from);
        }
    };

    try {
        for (const [from, to] of moves) {
            await mkdir(dirname(to), { recursive: true });
            await rename(from, to);
            completed.push([from, to]);
        }
    } catch (err) {
        await undo();
        throw err;
    }

    return undo;
}

/** Open every component relative to a held directory descriptor, refusing symlinks throughout. */
export async function secureShareDirectory(path: string): Promise<FileHandle> {
    if (process.platform !== "linux") {
        throw new Error("Privileged service provisioning requires Linux directory descriptors.");
    }

    let directory = await open("/", constants.O_RDONLY | constants.O_DIRECTORY);
    try {
        for (const name of resolve(path).split("/").filter(Boolean)) {
            const child = `/proc/self/fd/${directory.fd}/${name}`;
            await mkdir(child, { mode: 0o700 }).catch((err: unknown) => {
                if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) {
                    throw err;
                }
            });
            const next = await open(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
            await directory.close();
            directory = next;
        }

        return directory;
    } catch (err) {
        await directory.close();
        throw err;
    }
}

async function setConfigOwner(directory: FileHandle, account: ServiceAccount): Promise<void> {
    const file = await open(`/proc/self/fd/${directory.fd}/config.json`, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        await file.chown(account.uid, account.gid);
    } finally {
        await file.close();
    }
}

export async function waitForShareReady(
    server: ShareServerConfig,
    options: { timeoutMs?: number } = {}
): Promise<void> {
    const deadline = Date.now() + (options.timeoutMs ?? 15_000);
    const bind = server.listen.host;
    const host = bind === "0.0.0.0" ? "127.0.0.1" : bind === "::" || bind === "[::]" ? "::1" : bind;
    const url = new URL(PUBLISH_API.health, listenOrigin(host, server.listen.port));
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url, {
                signal: AbortSignal.timeout(Math.min(1000, Math.max(1, deadline - Date.now()))),
            });
            if (response.ok && response.headers.get(PUBLISH_SERVER_HEADER) === PUBLISH_SERVER_ID) {
                const health = HealthSchema.parse(await response.json());
                if (server.kinds.every((kind) => health.kinds.includes(kind))) {
                    return;
                }
            } else {
                await response.body?.cancel();
            }
        } catch (err) {
            logger.debug({ err, url: url.href }, "publish listener not ready");
        }

        const remaining = deadline - Date.now();
        if (remaining > 0) {
            await Bun.sleep(Math.min(200, remaining));
        }
    }

    throw new Error(`The publish listener at ${url.origin} did not become ready before its deadline.`);
}

async function ensureDirs(
    server: ShareServerConfig,
    account: ServiceAccount,
    ownerIsOtherUser: boolean,
    explicitDirs: readonly string[] = []
) {
    const shareRoot = genesisToolsDirIn(account.home, "share");
    const configRoot = dirname(shareRoot);
    const serverRoot = join(shareRoot, "servers", server.name);
    const folders = [configRoot, shareRoot, dirname(serverRoot), serverRoot, server.dataDir, server.stateDir];
    for (const dir of folders) {
        if (ownerIsOtherUser) {
            const directory = await secureShareDirectory(dir);
            try {
                const entry = await directory.stat();
                if (entry.uid !== 0 && entry.uid !== account.uid) {
                    throw new Error(`Publish folder is owned by another account: ${dir}`);
                }

                const managed = dir === configRoot || dir === shareRoot || dir.startsWith(`${shareRoot}/`);
                if (entry.uid === 0 && !managed && !explicitDirs.includes(dir)) {
                    throw new Error(`Existing root-owned folder needs an explicit directory choice: ${dir}`);
                }

                await directory.chown(account.uid, account.gid);
            } finally {
                await directory.close();
            }
        } else {
            await mkdir(dir, { recursive: true, mode: 0o700 });
        }
    }
}

export async function configureShareServer(
    opts: SetupServerOptions,
    overrides: Partial<SetupServerDeps> = {}
): Promise<{
    server: ShareServerConfig;
    home: string;
    installed: boolean;
}> {
    const deps = { ...defaultDeps(), ...overrides };
    const config = await commandShareConfig({ server: opts.server, configHome: opts.configHome });
    const interactive = deps.interactive && !opts.yes;
    const name = await textValue(interactive, "Server name", opts.server, config.defaults.server ?? "default");
    if (!TARGET_NAME_RE.test(name)) {
        throw new Error("Use a valid lowercase server name.");
    }

    const existing = config.servers.find((entry) => entry.name === name);
    const adoption = existing
        ? undefined
        : await findLegacyUnit({ path: opts.adoptUnit, name, adoptAutomatically: opts.yes ?? false, interactive });
    const previous = existing ?? adoption?.server;
    const portDefault = opts.port ?? previous?.listen.port ?? DEFAULT_PORT;
    const hostDefault = opts.host ?? previous?.listen.host ?? DEFAULT_HOST;
    const origin = await textValue(
        interactive,
        "Public origin",
        opts.publicOrigin,
        previous?.publicOrigin ?? listenOrigin(hostDefault, portDefault)
    );
    const port = Number(await textValue(interactive, "Listen port", opts.port?.toString(), String(portDefault)));
    const host = await textValue(interactive, "Listen host", opts.host, hostDefault);

    const manager = await choice({
        flag: "service",
        value: typeof opts.service === "string" ? opts.service : undefined,
        initial: previous?.service.manager ?? defaultManager(deps.platform),
        choices: managers,
        interactive: false,
        label: "Service manager",
    });
    const priorUser = previous?.service.manager === "systemd" ? previous.service.user : undefined;
    if (adoption && opts.serviceUser && opts.serviceUser !== priorUser) {
        throw new Error(
            "Adopt using the existing service user. Migrate account ownership separately before changing --service-user."
        );
    }
    const hintedUser = opts.serviceUser ?? priorUser ?? "genesis-share";
    const hint = manager === "systemd" && deps.account.uid === 0 ? await lookupAccount(hintedUser) : undefined;
    const home = hint?.home ?? deps.account.home;
    const serverRoot = genesisToolsDirIn(home, "share", "servers", name);
    const move =
        adoption &&
        (opts.yes ||
            (interactive &&
                (await p.confirm({
                    message: `Move data and state into ${serverRoot}? [yes]`,
                    initialValue: true,
                }))));
    const dataDir = resolve(
        await textValue(
            interactive,
            "Data folder",
            opts.dataDir,
            move ? join(serverRoot, "data") : (previous?.dataDir ?? join(serverRoot, "data"))
        )
    );
    const stateDir = resolve(
        await textValue(
            interactive,
            "State folder",
            opts.stateDir,
            move ? join(serverRoot, "state") : (previous?.stateDir ?? join(serverRoot, "state"))
        )
    );
    const exposure = await choice({
        flag: "exposure",
        value: opts.exposure,
        initial: previous?.exposure.kind ?? "local",
        choices: exposures,
        interactive,
        label: "Exposure",
    });
    const proxy =
        exposure === "reverse-proxy"
            ? await choice({
                  flag: "proxy",
                  value: opts.proxy,
                  initial: previous?.exposure.kind === "reverse-proxy" ? previous.exposure.proxy : "apache",
                  choices: proxies,
                  interactive,
                  label: "Reverse proxy",
              })
            : undefined;
    const tunnel =
        exposure === "cloudflared"
            ? await textValue(
                  interactive,
                  "Tunnel name",
                  opts.tunnel,
                  previous?.exposure.kind === "cloudflared" ? previous.exposure.tunnel : name
              )
            : undefined;
    const serviceManager = await choice({
        flag: "service",
        value: opts.service,
        initial: manager,
        choices: managers,
        interactive,
        label: "Service manager",
    });
    const owner = await serviceAccount({ ...deps, interactive }, serviceManager, opts.serviceUser ?? priorUser);
    const defaultHomeChanged = owner.home !== home && (move || previous === undefined);
    const finalRoot = genesisToolsDirIn(owner.home, "share", "servers", name);
    const ownedData =
        defaultHomeChanged && opts.dataDir === undefined && dataDir === join(serverRoot, "data")
            ? join(finalRoot, "data")
            : dataDir;
    const ownedState =
        defaultHomeChanged && opts.stateDir === undefined && stateDir === join(serverRoot, "state")
            ? join(finalRoot, "state")
            : stateDir;
    const server = ShareServerConfigSchema.parse({
        name,
        dataDir: ownedData,
        stateDir: ownedState,
        listen: { host, port },
        publicOrigin: parsePublicOrigin(origin, PUBLISH_KIND_IDS),
        kinds: previous?.kinds ?? PUBLISH_KIND_IDS,
        minFreeGb: previous?.minFreeGb ?? 2,
        exposure: proxy
            ? { kind: "reverse-proxy", proxy }
            : tunnel
              ? { kind: "cloudflared", tunnel }
              : { kind: "local" },
        service:
            serviceManager === "systemd"
                ? {
                      manager: serviceManager,
                      unit:
                          previous?.service.manager === "systemd"
                              ? previous.service.unit
                              : name === "default"
                                ? DEFAULT_UNIT
                                : `genesis-share-${name}.service`,
                      user: owner.name,
                  }
                : serviceManager === "launchd"
                  ? { manager: serviceManager, label: `dev.genesis-tools.share.${name}` }
                  : { manager: serviceManager },
    });
    const installer = deps.installer(server);
    const unitInput: ServiceUnitInput = {
        server,
        checkoutDir: resolve(opts.root ?? PROJECT_ROOT),
        command: [
            resolve(opts.bun ?? process.execPath),
            join(resolve(opts.root ?? PROJECT_ROOT), "src/dev-dashboard/index.ts"),
            "share-server",
            "serve",
            "--server",
            server.name,
        ],
        home: owner.home,
    };
    if (serviceManager === "systemd" && deps.account.uid !== 0 && !opts.yes) {
        const unitFile = stagedSystemdUnit(unitInput);
        await writeServiceFile(unitFile, installer.render(unitInput));
        for (const argv of installer.installCommands({ ...unitInput, unitFile })) {
            out.println(shellCommandLine(["sudo", ...argv]));
        }

        if (
            !interactive ||
            !(await p.confirm({
                message: "Run these sudo commands and restart the service? [yes]",
                initialValue: true,
            }))
        ) {
            throw new MissingSetupValueError("yes");
        }
    }

    const ownerIsOtherUser = deps.account.uid === 0 && owner.uid !== 0;
    const file =
        owner.home === env.tools.getHome() ? shareConfigPath() : genesisToolsDirIn(owner.home, "share", "config.json");
    let beforeSave: ShareConfig | undefined;
    let undo: (() => Promise<void>) | undefined;
    let installStarted = false;
    let shareDirectory: FileHandle | undefined;
    const priorService = adoption ? deps.installer(adoption.server) : undefined;
    if (move) {
        await priorService?.stop(adoption.server);
    }

    try {
        if (move) {
            undo = await moveAdoptedShareFolders(adoption.server, server);
        }

        await ensureDirs(
            server,
            owner,
            ownerIsOtherUser,
            [opts.dataDir, opts.stateDir].filter((dir): dir is string => dir !== undefined)
        );
        if (ownerIsOtherUser) {
            shareDirectory = await secureShareDirectory(genesisToolsDirIn(owner.home, "share"));
        }

        const configPath = shareDirectory ? `/proc/self/fd/${shareDirectory.fd}/config.json` : undefined;
        if (configPath) {
            const entry = await lstat(configPath).catch((err: unknown) => {
                if (!isMissingPathError(err)) {
                    throw err;
                }

                return undefined;
            });
            if (entry?.isSymbolicLink()) {
                throw new Error("Refusing a symlinked share configuration.");
            }
        }

        await updateShareConfigForHome({
            path: configPath,
            home: owner.home,
            change: (current) => {
                beforeSave = current;
                return {
                    ...current,
                    defaults: { ...current.defaults, server: current.defaults.server ?? name },
                    servers: [...current.servers.filter((entry) => entry.name !== name), server],
                };
            },
        });
        if (shareDirectory) {
            await setConfigOwner(shareDirectory, owner);
        }

        out.println(`Saved server ${name} in ${file}`);
        if (server.exposure.kind === "reverse-proxy") {
            out.println(`For ${server.publicOrigin}, use ${proxyLocations[server.exposure.proxy]}.`);
            out.println(proxySnippet({ proxy: server.exposure.proxy, server }));
        }

        await deps.prepareExposure?.(server);
        installStarted = true;
        const { unitFile } = await installer.install(unitInput);
        if (unitFile) {
            out.println(`Installed ${unitFile}`);
        }

        await installer.restart(server);
        if (serviceManager !== "none") {
            await (deps.waitUntilReady ?? waitForShareReady)(server);
        }
    } catch (err) {
        if (adoption && priorService) {
            const errors: unknown[] = [];
            const attempt = async (restore: () => Promise<void>) => {
                try {
                    await restore();
                } catch (failure) {
                    errors.push(failure);
                }
            };

            if (installStarted) {
                await attempt(() => installer.stop(server));
            }

            if (undo) {
                await attempt(undo);
            }

            const previous = beforeSave;
            if (previous) {
                await attempt(async () => {
                    const saved = previous.servers.find((entry) => entry.name === name);
                    await updateShareConfigForHome({
                        home: owner.home,
                        path: shareDirectory ? `/proc/self/fd/${shareDirectory.fd}/config.json` : undefined,
                        change: (current) => ({
                            ...current,
                            defaults: {
                                ...current.defaults,
                                server:
                                    current.defaults.server === name
                                        ? previous.defaults.server
                                        : current.defaults.server,
                            },
                            servers: [
                                ...current.servers.filter((entry) => entry.name !== name),
                                ...(saved ? [saved] : []),
                            ],
                        }),
                    });
                    if (shareDirectory) {
                        await setConfigOwner(shareDirectory, owner);
                    }
                });
            }

            if (move || installStarted) {
                await attempt(async () => {
                    const run =
                        deps.runSystemCommand ??
                        ((args) => runServiceCommand(deps.account.uid === 0 ? args : ["sudo", ...args]));
                    await withStagedSystemdUnit(adoption.text, async (staged) => {
                        await run(["install", "-m", "0644", "--", staged, adoption.path]);
                    });
                    await run(["systemctl", "daemon-reload"]);
                    await priorService.restart(adoption.server);
                });
            }

            if (errors.length) {
                throw new AggregateError([err, ...errors], "Share service setup failed and rollback was incomplete");
            }
        }

        throw err;
    } finally {
        await shareDirectory?.close();
    }

    return { server, home: owner.home, installed: serviceManager !== "none" };
}
