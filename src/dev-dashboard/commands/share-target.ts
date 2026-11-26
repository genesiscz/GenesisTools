import { importLegacyShare, loadSharePublishConfig } from "@app/dev-dashboard/lib/share/legacy-share";
import { isInteractive, suggestCommand, suggestEnumFlag } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { loadShareConfig, updateShareConfig } from "@genesiscz/utils/genesis-tools/publish/store";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { auditClientOperation } from "@genesiscz/utils/publish/audit";
import { ALL_TARGETS, TARGET_NAME_RE } from "@genesiscz/utils/publish/targets";
import {
    isTransportKind,
    PUBLISH_TRANSPORTS,
    TRANSPORT_KINDS,
    transportFor,
} from "@genesiscz/utils/publish/transports";
import { tokenPath } from "@genesiscz/utils/publish/transports/paired";
import {
    MissingSetupValueError,
    type SetupAsk,
    type TransportSetupInput,
} from "@genesiscz/utils/publish/transports/types";
import { resolveSecret, secrets } from "@genesiscz/utils/security";
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
    replace?: boolean;
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
    return withFileLock(toolDataDir("share", `.target-${name}.lock`), change, 30_000);
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
        const replaced = await withTargetLock(name, async () => {
            const config = await loadShareConfig();
            const previous = config.targets.find((target) => target.name === name);
            if (previous && !opts.replace) {
                throw new Error(`a share target named "${name}" exists; ${TOOL} remove ${name} first`);
            }

            const pair = previous?.transport.kind === "paired" ? previous.transport : undefined;
            const oldToken =
                pair?.token.path === tokenPath(name)
                    ? await auditClientOperation(
                          { action: "token-read", target: name, deviceId: pair.deviceId },
                          () => resolveSecret(pair.token),
                          (value) => ({ status: value ? 200 : 404 })
                      )
                    : undefined;
            if (pair && previous) {
                input.values["previous-device-id"] = pair.deviceId;
                const url = opts.url ?? pair.url;
                input.values.url = url;
                if (!opts.publicBase && URL.canParse(url) && new URL(url).origin === pair.url) {
                    input.values["public-base"] = previous.publicBase;
                }
            }

            const target = await transport.setup(input);
            try {
                await updateShareConfig((current) => ({
                    ...current,
                    defaults: opts.default ? { ...current.defaults, target: name } : current.defaults,
                    targets: previous
                        ? current.targets.map((entry) => (entry.name === name ? target : entry))
                        : [...current.targets, target],
                }));
            } catch (err) {
                if (pair && oldToken !== undefined) {
                    await (await secrets()).set(pair.token.path, oldToken);
                } else {
                    await transport.forget(target);
                }

                throw err;
            }

            if (pair && target.transport.kind === "paired") {
                if (pair.token.path !== target.transport.token.path) {
                    await auditClientOperation(
                        { action: "forget", target: name, deviceId: pair.deviceId },
                        async () => (await secrets()).delete(pair.token.path),
                        (deleted) => ({ status: deleted ? 200 : 404 })
                    ).catch((err: unknown) =>
                        logger.warn({ err, target: name }, "could not remove the previous token from the local vault")
                    );
                }

                const revoke = toolCommand("dev-dashboard share-server devices", "--revoke", pair.deviceId);
                out.println(`Previous device ${pair.deviceId} on ${pair.url}. Revoke it on that server with ${revoke}`);
            }

            return previous !== undefined;
        });
        out.println(
            `${replaced ? "updated" : "added"} share target ${name} (${kind})${opts.default ? ", now the default" : ""}`
        );
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
    const config = await loadSharePublishConfig();
    for (const target of config.targets) {
        const marker = target.name === config.defaults.target ? "*" : " ";
        const link = transportFor(target).pageUrl({ target, kind: "md", id: "SLUG" }) ?? "no note mount";
        out.println(`${marker} ${target.name}\t${target.transport.kind}\t${link.replace("SLUG", "<slug>")}`);
    }

    await out.flush();
}

export async function runTargetRemove(name: string): Promise<void> {
    validateTargetName(name);
    await importLegacyShare();
    await withTargetLock(name, async () => {
        const config = await loadShareConfig();
        const target = config.targets.find((entry) => entry.name === name);
        if (!target) {
            throw new Error(`no share target "${name}"`);
        }

        await updateShareConfig((current) => {
            if (current.defaults.target === name) {
                throw new Error(`"${name}" is the default target; pick another with ${TOOL} default <name> first`);
            }

            return {
                ...current,
                targets: current.targets.filter((entry) => entry.name !== name),
            };
        });
        const forget = () => transportFor(target).forget(target);
        if (target.transport.kind === "paired") {
            await forget();
        } else {
            await auditClientOperation({ action: "forget", target: name }, forget);
        }
    });
    out.println(`removed share target ${name}`);
    await out.flush();
}

export async function runTargetDefault(name: string): Promise<void> {
    validateTargetName(name);
    await importLegacyShare();
    await updateShareConfig((config) => {
        if (!config.targets.some((entry) => entry.name === name)) {
            throw new Error(`no share target "${name}"`);
        }

        return { ...config, defaults: { ...config.defaults, target: name } };
    });
    out.println(`default share target: ${name}`);
    await out.flush();
}
