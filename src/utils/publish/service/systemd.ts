import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { genesisToolsDirIn } from "@genesiscz/utils/storage/root";
import type { ShareServerConfig } from "../../genesis-tools/publish/store";
import {
    runServiceCommand,
    type ServiceInstaller,
    type ServiceRunner,
    type ServiceUnitInput,
    writeServiceFile,
} from "./types";

export const SYSTEMD_UNITS = "/etc/systemd/system";

function unitName(server: ShareServerConfig): string {
    if (server.service.manager !== "systemd") {
        throw new Error("Expected a systemd server");
    }

    const name = server.service.unit;
    return name.endsWith(".service") ? name : `${name}.service`;
}

export function stagedSystemdUnit(input: ServiceUnitInput): string {
    return genesisToolsDirIn(input.home, "share", "servers", input.server.name, "service", unitName(input.server));
}

function quote(value: string): string {
    const escaped = value
        .replaceAll("\\", "\\\\")
        .replaceAll('"', '\\"')
        .replaceAll("%", "%%")
        .replaceAll("$", () => "$$");
    return /^[A-Za-z0-9_./=:-]+$/.test(escaped) ? escaped : `"${escaped}"`;
}

function render(input: ServiceUnitInput): string {
    const { server, checkoutDir, bunPath, home } = input;
    if (server.service.manager !== "systemd") {
        throw new Error("Expected a systemd server");
    }

    const program = [
        bunPath,
        join(checkoutDir, "src/dev-dashboard/index.ts"),
        "share-server",
        "serve",
        "--server",
        server.name,
    ];
    return [
        "[Unit]",
        "Description=GenesisTools publish server",
        "After=network-online.target",
        "Wants=network-online.target",
        "",
        "[Service]",
        "Type=simple",
        `User=${server.service.user}`,
        `WorkingDirectory=${quote(checkoutDir)}`,
        `ExecStart=${program.map(quote).join(" ")}`,
        `Environment=${quote(`HOME=${home}`)}`,
        `Environment=${quote(`GENESIS_TOOLS_HOME=${home}`)}`,
        `Environment=${quote(`GENESIS_TOOLS_LOG_DIR=${join(server.stateDir, "logs")}`)}`,
        "Restart=on-failure",
        "RestartSec=5",
        "NoNewPrivileges=yes",
        "PrivateTmp=yes",
        "ProtectSystem=strict",
        "ProtectHome=read-only",
        `ReadWritePaths=${[server.dataDir, server.stateDir].map(quote).join(" ")}`,
        "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX",
        "CapabilityBoundingSet=",
        "",
        "[Install]",
        "WantedBy=multi-user.target",
        "",
    ].join("\n");
}

export function createSystemdInstaller(
    deps: { unitDir?: string; run?: ServiceRunner; root?: boolean } = {}
): ServiceInstaller & { readonly manager: "systemd" } {
    const unitDir = deps.unitDir ?? SYSTEMD_UNITS;
    const run = deps.run ?? runServiceCommand;
    const root = deps.root ?? process.getuid?.() === 0;
    const elevated: ServiceRunner = (argv) => run(root ? argv : ["sudo", ...argv]);

    const installCommands: ServiceInstaller["installCommands"] = ({ server, unitFile }) => [
        ["install", "-m", "0644", "--", unitFile, join(unitDir, unitName(server))],
        ["systemctl", "daemon-reload"],
    ];

    return {
        manager: "systemd",
        render,
        installCommands,
        async install(input) {
            const source = stagedSystemdUnit(input);
            await writeServiceFile(source, render(input));
            for (const argv of installCommands({ ...input, unitFile: source })) {
                await elevated(argv);
            }

            return { unitFile: join(unitDir, unitName(input.server)) };
        },
        async restart(server) {
            const unit = unitName(server);
            await elevated(["systemctl", "enable", unit]);
            await elevated(["systemctl", "restart", unit]);
        },
        stop: (server) => elevated(["systemctl", "disable", "--now", unitName(server)]),
        async isActive(server) {
            try {
                await run(["systemctl", "is-active", "--quiet", unitName(server)]);
                return true;
            } catch (err) {
                logger.debug({ err, server: server.name }, "systemd publish service inactive");
                return false;
            }
        },
    };
}

export const systemdInstaller = createSystemdInstaller();
