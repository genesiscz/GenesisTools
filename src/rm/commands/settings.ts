import { toolCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import {
    allPresets,
    appendRmLedger,
    BUILTIN_PROFILES,
    defaultTrashPaths,
    isAskAction,
    isRmApproval,
    isRmNotifyOnRequest,
    isTrashRootName,
    loadRmConfig,
    presetsFor,
    RM_APPROVALS,
    RM_NOTIFY_ON_REQUEST,
    type RmConfig,
    rmConfigPath,
    saveRmConfig,
    type TrashPaths,
    trashRootChangeBlocker,
    whileChangingTrashRoot,
} from "@genesiscz/utils/rm";
import type { Command } from "commander";
import pc from "picocolors";
import { minutesOption, requirePerson, runContext } from "../lib/run";

const SETTINGS = [
    "approval",
    "notify-on-request",
    "ask-action",
    "aside-unsaved",
    "session-scratch",
    "own-files",
    "grace-preset",
    "grace-other",
    "trash-root",
    "disable-preset",
    "enable-preset",
    "disable-profile",
    "enable-profile",
] as const;

function yesNo(value: string): boolean {
    if (/^(yes|true|on|1)$/i.test(value)) {
        return true;
    }

    if (/^(no|false|off|0)$/i.test(value)) {
        return false;
    }

    throw new Error(`Not yes or no: ${value}`);
}
export type Setting = (typeof SETTINGS)[number];

function isSetting(key: string): key is Setting {
    return SETTINGS.some((setting) => setting === key);
}

/** The config after `config set <key> <value>`; throws on a value the setting does not take. */
export function applyRmSetting(config: RmConfig, key: Setting, value: string): RmConfig {
    switch (key) {
        case "approval":
            if (!isRmApproval(value)) {
                throw new Error(`approval takes ${RM_APPROVALS.join(", ")}.`);
            }

            return { ...config, approval: value };
        case "notify-on-request":
            if (!isRmNotifyOnRequest(value)) {
                throw new Error(`notify-on-request takes ${RM_NOTIFY_ON_REQUEST.join(", ")}.`);
            }

            return { ...config, notify: { ...config.notify, onRequest: value } };
        case "ask-action":
            if (!isAskAction(value)) {
                throw new Error("ask-action takes aside or request.");
            }

            return { ...config, askAction: value };
        case "aside-unsaved":
            return { ...config, asideUnsaved: yesNo(value) };
        case "session-scratch":
            return { ...config, allowSessionScratch: yesNo(value) };
        case "own-files":
            return { ...config, allowOwnFiles: yesNo(value) };
        case "grace-preset":
            return { ...config, grace: { ...config.grace, presetMinutes: minutesOption(value) } };
        case "grace-other":
            return { ...config, grace: { ...config.grace, otherMinutes: minutesOption(value) } };
        case "trash-root":
            if (!isTrashRootName(value)) {
                throw new Error("The trash root must be an absolute path with a GenesisTools folder in it.");
            }

            return { ...config, trashRoot: value };
        case "disable-preset":
            return { ...config, disabledPresets: [...new Set([...config.disabledPresets, value])] };
        case "enable-preset":
            return {
                ...config,
                disabledPresets: config.disabledPresets.filter((id) => id !== value),
                // Custom presets can be opt-in too, so every preset the config knows counts, not only the shipped ones.
                enabledPresets: allPresets(config).some((p) => p.id === value && p.optIn)
                    ? [...new Set([...config.enabledPresets, value])]
                    : config.enabledPresets,
            };
        case "disable-profile":
            if (!BUILTIN_PROFILES.some((p) => p.name === value)) {
                throw new Error(
                    `No built-in profile ${value}; remove your own with ${toolCommand("rm")} profile remove.`
                );
            }

            return { ...config, disabledProfiles: [...new Set([...config.disabledProfiles, value])] };
        case "enable-profile":
            return { ...config, disabledProfiles: config.disabledProfiles.filter((name) => name !== value) };
    }
}

/**
 * Saves `config set <key> <value>` onto the config as it is now. The person may take minutes to confirm, so the
 * file is read again (a setting saved meanwhile stays), and a trash-root move checks the old root again right before
 * the save: a batch moved there while the person decided would otherwise be left behind the new root. That check
 * and the save run under the trash-root change marker, so a run that claims a batch meanwhile moves nothing.
 */
export function saveRmSetting(input: {
    key: Setting;
    value: string;
    drainCommand: string;
    paths?: TrashPaths;
    configPath?: string;
    /** Between the trash-root check and the save. */
    hooks?: { afterCheck?: () => void };
}): { saved: RmConfig } | { blocked: string } {
    const save = (): { saved: RmConfig } | { blocked: string } => {
        const current = loadRmConfig(input.configPath);
        const blocked =
            input.key === "trash-root"
                ? trashRootChangeBlocker(current, input.value, input.paths, input.drainCommand)
                : null;

        if (blocked) {
            return { blocked };
        }

        input.hooks?.afterCheck?.();
        const saved = applyRmSetting(current, input.key, input.value);
        saveRmConfig(saved, input.configPath);
        return { saved };
    };

    return input.key === "trash-root" ? whileChangingTrashRoot(input.paths ?? defaultTrashPaths(), save) : save();
}

export function registerSettingsCommands(program: Command): void {
    program
        .command("presets")
        .description(`the folder kinds ${toolCommand("rm")} deletes without asking`)
        .option("--json", "print as JSON")
        .action((flags: { json?: boolean }) => {
            const { config } = runContext();
            const all = allPresets(config);
            const enabled = new Set(presetsFor(config).map((preset) => preset.id));

            if (flags.json) {
                out.result(all.map((preset) => ({ ...preset, enabled: enabled.has(preset.id) })));
                return;
            }

            for (const preset of all) {
                const off = enabled.has(preset.id)
                    ? ""
                    : preset.optIn && !config.disabledPresets.includes(preset.id)
                      ? pc.yellow(` (opt-in: ${toolCommand("rm")} config set enable-preset ${preset.id})`)
                      : pc.red(" (disabled)");
                const names = preset.within ? `every folder in ${preset.within}` : preset.names.join(", ");
                const markers = preset.markers ? ` next to ${preset.markers.join(" or ")}` : "";
                const parents = preset.parentNames ? ` inside ${preset.parentNames.join(" or ")}` : "";
                out.println(`${pc.bold(preset.id)}${off} ${preset.description}`);
                out.println(pc.dim(`  ${names}${markers}${parents}`));
            }
        });

    const config = program.command("config").description(`${toolCommand("rm")} settings (changing one needs a person)`);

    config
        .command("show", { isDefault: true })
        .description("print the settings and where they live")
        .action(() => {
            const { config: current } = runContext();
            out.println(pc.dim(rmConfigPath()));
            out.result(current);
        });

    config
        .command("set")
        .description(`change a setting: ${SETTINGS.join(", ")}`)
        .argument("<key>", SETTINGS.join(" | "))
        .argument("<value>", "minutes (30m, 2h), a path, or a preset id")
        .action(async (key: string, value: string) => {
            const ctx = runContext();

            if (!isSetting(key)) {
                out.println(pc.red(`Unknown setting ${key}. Settings: ${SETTINGS.join(", ")}`));
                process.exitCode = 1;
                return;
            }

            const drainCommand = `${toolCommand("rm")} drain --now`;
            // A value the setting does not take throws here, before anyone is asked.
            applyRmSetting(ctx.base, key, value);
            const blocked =
                key === "trash-root" ? trashRootChangeBlocker(ctx.base, value, undefined, drainCommand) : null;

            if (blocked) {
                out.println(pc.red(`Not changing trash-root: ${blocked}`));
                process.exitCode = 1;
                return;
            }

            const answer = await requirePerson(ctx, {
                title: `Set ${key} to ${value}?`,
                lines: [`${key} = ${value}`],
                code: "set",
            });

            if (answer.approved) {
                const result = saveRmSetting({ key, value, drainCommand });

                if ("blocked" in result) {
                    out.println(pc.red(`Not changing trash-root: ${result.blocked}`));
                    process.exitCode = 1;
                    return;
                }

                appendRmLedger({
                    action: "config-set",
                    reason: `${key} = ${value}`,
                    via: answer.via,
                    caller: ctx.caller,
                });
                out.println(pc.green(`${key} = ${value}`));
            }
        });
}
