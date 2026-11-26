import { getConfig } from "@app/dev-dashboard/config";
import { saveShareConfig } from "@app/dev-dashboard/lib/obsidian/publish";
import { driverFor, isShareDriverKind, SHARE_DRIVER_KINDS, SHARE_DRIVERS } from "@app/dev-dashboard/lib/share/drivers";
import { SHARE_TARGET_NAME_RE } from "@app/dev-dashboard/lib/share/drivers/target-base";
import {
    MissingSetupValueError,
    type SetupAsk,
    type ShareTargetSetupInput,
} from "@app/dev-dashboard/lib/share/drivers/types";
import { isInteractive, suggestCommand, suggestEnumFlag } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";

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

/** `share target add <name> --driver <kind> [driver flags]`: the driver's guided setup, then save the target. */
export async function runTargetAdd(name: string, opts: TargetAddOptions): Promise<void> {
    try {
        if (!SHARE_TARGET_NAME_RE.test(name)) {
            throw new Error(`target name "${name}": lowercase letters, digits and dashes, up to 32`);
        }

        let kind = opts.driver;

        if (!kind && isInteractive()) {
            kind = await p.select({
                message: "How should shares reach this target?",
                options: SHARE_DRIVER_KINDS.map((value) => ({
                    value,
                    label: value,
                    hint: SHARE_DRIVERS[value].summary,
                })),
            });
        }

        if (!kind || !isShareDriverKind(kind)) {
            out.printlnErr(suggestEnumFlag(`${TOOL} add ${name}`, "--driver", SHARE_DRIVER_KINDS));
            process.exitCode = 1;
            return;
        }

        const config = await getConfig();

        if (config.share.targets.some((target) => target.name === name)) {
            throw new Error(`a share target named "${name}" exists; \`${TOOL} remove ${name}\` first`);
        }

        const input: ShareTargetSetupInput = {
            name,
            values: {
                url: opts.url,
                code: opts.code,
                host: opts.host,
                "data-dir": opts.dataDir,
                "public-base": opts.publicBase,
                "device-name": opts.deviceName,
            },
            ask: isInteractive() ? askInTerminal : askNever,
        };
        const target = await SHARE_DRIVERS[kind].setup(input);
        const fresh = await getConfig();
        await saveShareConfig({
            defaults: { target: opts.default ? name : fresh.share.defaults.target },
            targets: [...fresh.share.targets, target],
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
    const { share } = await getConfig();

    for (const target of share.targets) {
        const marker = target.name === share.defaults.target ? "*" : " ";
        out.println(`${marker} ${target.name}\t${target.driver}\t${await driverFor(target).pageUrl(target, "<slug>")}`);
    }

    await out.flush();
}

export async function runTargetRemove(name: string): Promise<void> {
    const { share } = await getConfig();
    const target = share.targets.find((entry) => entry.name === name);

    if (!target) {
        out.error(`no share target "${name}"`);
        process.exitCode = 1;
        return;
    }

    if (share.defaults.target === name) {
        out.error(`"${name}" is the default target; pick another with \`${TOOL} default <name>\` first`);
        process.exitCode = 1;
        return;
    }

    await driverFor(target).forget(target);
    await saveShareConfig({ ...share, targets: share.targets.filter((entry) => entry.name !== name) });
    out.println(`removed share target ${name}`);
    await out.flush();
}

export async function runTargetDefault(name: string): Promise<void> {
    const { share } = await getConfig();

    if (!share.targets.some((entry) => entry.name === name)) {
        out.error(`no share target "${name}"`);
        process.exitCode = 1;
        return;
    }

    await saveShareConfig({ ...share, defaults: { ...share.defaults, target: name } });
    out.println(`default share target: ${name}`);
    await out.flush();
}
