import { importLegacyShare, loadSharePublishConfig } from "@app/dev-dashboard/lib/share/legacy-share";
import { isInteractive, suggestCommand, suggestEnumFlag } from "@genesiscz/utils/cli";
import { loadPublishConfig, updatePublishConfig } from "@genesiscz/utils/genesis-tools/publish/store";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { ALL_TARGETS, TARGET_NAME_RE } from "@genesiscz/utils/publish/targets";
import {
    isTransportKind,
    PUBLISH_TRANSPORTS,
    TRANSPORT_KINDS,
    transportFor,
} from "@genesiscz/utils/publish/transports";
import {
    MissingSetupValueError,
    type SetupAsk,
    type TransportSetupInput,
} from "@genesiscz/utils/publish/transports/types";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { toolDataDir } from "@genesiscz/utils/storage/root";

const TOOL = "tools dev-dashboard share target";

export interface TargetAddOptions {
    driver?: string;
    url?: string;
    code?: string;
    host?: string;
    dataDir?: string;
    publicBase?: string;
    deviceName?: string;
    default?: boolean;
}

const askInTerminal: SetupAsk = async (prompt) =>
    p.text({ message: prompt.message, initialValue: prompt.initial, validate: prompt.validate });

const askNever: SetupAsk = async (prompt) => {
    throw new MissingSetupValueError(prompt.flag);
};

function validateTargetName(name: string): void {
    if (!TARGET_NAME_RE.test(name) || name === ALL_TARGETS) {
        throw new Error(`target name "${name}": use lowercase letters, digits and dashes, up to 32, except "all"`);
    }
}

function withTargetLock<T>(name: string, change: () => Promise<T>): Promise<T> {
    return withFileLock(toolDataDir("publish", `.target-${name}.lock`), change, 30_000);
}

export async function runTargetAdd(name: string, opts: TargetAddOptions): Promise<void> {
    try {
        validateTargetName(name);
        let kind = opts.driver;
        if (!kind && isInteractive()) {
            kind = await p.select({
                message: "How should shares reach this target?",
                options: TRANSPORT_KINDS.map((value) => ({
                    value,
                    label: value,
                    hint: PUBLISH_TRANSPORTS[value].summary,
                })),
            });
        }

        if (!kind || !isTransportKind(kind)) {
            out.printlnErr(suggestEnumFlag(`${TOOL} add ${name}`, "--driver", TRANSPORT_KINDS));
            process.exitCode = 1;
            return;
        }

        const transport = PUBLISH_TRANSPORTS[kind];
        await importLegacyShare();
        const path =
            opts.publicBase && URL.canParse(opts.publicBase)
                ? new URL(opts.publicBase).pathname.replace(/\/+$/, "")
                : "";
        const input: TransportSetupInput = {
            name,
            values: {
                url: opts.url,
                code: opts.code,
                host: opts.host,
                "data-dir": opts.dataDir,
                "public-base": opts.publicBase,
                "device-name": opts.deviceName,
                mounts: kind === "mac-live" && opts.publicBase ? `md=${path || "/share"}` : undefined,
            },
            ask: isInteractive() ? askInTerminal : askNever,
        };
        await withTargetLock(name, async () => {
            const config = await loadPublishConfig();
            if (config.client.targets.some((target) => target.name === name)) {
                throw new Error(`a share target named "${name}" exists; ${TOOL} remove ${name} first`);
            }

            const target = await transport.setup(input);
            await updatePublishConfig((current) => ({
                ...current,
                client: {
                    defaults: opts.default ? { target: name } : current.client.defaults,
                    targets: [...current.client.targets, target],
                },
            }));
        });
        out.println(`added share target ${name} (${kind})${opts.default ? ", now the default" : ""}`);
    } catch (err) {
        if (err instanceof MissingSetupValueError) {
            out.error(`${err.message} in non-interactive mode`);
            out.printlnErr(
                suggestCommand(TOOL, {
                    replaceCommand: ["add", name, "--driver", opts.driver ?? "<driver>", `--${err.flag}`, "<value>"],
                })
            );
        } else {
            out.error(err instanceof Error ? err.message : String(err));
        }

        process.exitCode = 1;
    }

    await out.flush();
}

export async function runTargetList(): Promise<void> {
    const { client } = await loadSharePublishConfig();
    for (const target of client.targets) {
        const marker = target.name === client.defaults.target ? "*" : " ";
        const link = transportFor(target).pageUrl({ target, kind: "md", id: "SLUG" }) ?? "no note mount";
        out.println(`${marker} ${target.name}\t${target.transport.kind}\t${link.replace("SLUG", "<slug>")}`);
    }

    await out.flush();
}

export async function runTargetRemove(name: string): Promise<void> {
    validateTargetName(name);
    await importLegacyShare();
    await withTargetLock(name, async () => {
        const { client } = await loadPublishConfig();
        const target = client.targets.find((entry) => entry.name === name);
        if (!target) {
            throw new Error(`no share target "${name}"`);
        }

        await updatePublishConfig((current) => {
            if (current.client.defaults.target === name) {
                throw new Error(`"${name}" is the default target; pick another with ${TOOL} default <name> first`);
            }

            return {
                ...current,
                client: { ...current.client, targets: current.client.targets.filter((entry) => entry.name !== name) },
            };
        });
        await transportFor(target).forget(target);
    });
    out.println(`removed share target ${name}`);
    await out.flush();
}

export async function runTargetDefault(name: string): Promise<void> {
    validateTargetName(name);
    await importLegacyShare();
    await updatePublishConfig((config) => {
        if (!config.client.targets.some((entry) => entry.name === name)) {
            throw new Error(`no share target "${name}"`);
        }

        return { ...config, client: { ...config.client, defaults: { target: name } } };
    });
    out.println(`default share target: ${name}`);
    await out.flush();
}
