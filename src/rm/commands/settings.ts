import { out } from "@genesiscz/utils/logger";
import {
    BUILTIN_PRESETS,
    isAskAction,
    isTrashRootName,
    type RmConfig,
    rmConfigPath,
    saveRmConfig,
} from "@genesiscz/utils/rm";
import type { Command } from "commander";
import pc from "picocolors";
import { minutesOption, requirePerson, runContext } from "../lib/run";

const SETTINGS = [
    "ask-action",
    "aside-unsaved",
    "session-scratch",
    "own-files",
    "grace-preset",
    "grace-other",
    "trash-root",
    "disable-preset",
    "enable-preset",
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
type Setting = (typeof SETTINGS)[number];

function isSetting(key: string): key is Setting {
    return SETTINGS.some((setting) => setting === key);
}

function apply(config: RmConfig, key: Setting, value: string): RmConfig {
    switch (key) {
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
            return { ...config, disabledPresets: config.disabledPresets.filter((id) => id !== value) };
    }
}

export function registerSettingsCommands(program: Command): void {
    program
        .command("presets")
        .description("the folder kinds tools rm deletes without asking")
        .option("--json", "print as JSON")
        .action((flags: { json?: boolean }) => {
            const { config } = runContext();
            const all = [...BUILTIN_PRESETS, ...config.customPresets];

            if (flags.json) {
                out.result(all.map((preset) => ({ ...preset, enabled: !config.disabledPresets.includes(preset.id) })));
                return;
            }

            for (const preset of all) {
                const off = config.disabledPresets.includes(preset.id) ? pc.red(" (disabled)") : "";
                const names = preset.within ? `every folder in ${preset.within}` : preset.names.join(", ");
                const markers = preset.markers ? ` next to ${preset.markers.join(" or ")}` : "";
                const parents = preset.parentNames ? ` inside ${preset.parentNames.join(" or ")}` : "";
                out.println(`${pc.bold(preset.id)}${off} ${preset.description}`);
                out.println(pc.dim(`  ${names}${markers}${parents}`));
            }
        });

    const config = program.command("config").description("tools rm settings (changing one needs a person)");

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

            const next = apply(ctx.base, key, value);
            const answer = await requirePerson(ctx, {
                title: `Set ${key} to ${value}?`,
                lines: [`${key} = ${value}`],
                code: "set",
            });

            if (answer.approved) {
                saveRmConfig(next);
                out.println(pc.green(`${key} = ${value}`));
            }
        });
}
