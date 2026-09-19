import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { createBoxTable, formatDotStatus, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import {
    JEV_SETTINGS,
    type JevSettingKey,
    type JevSettings,
    jevSettingsPath,
    loadJevSettings,
    parseSettingKey,
    type SettingSpec,
    setJevSetting,
    settingAt,
    unsetJevSetting,
} from "./settings";

interface ConfigOptions {
    json?: boolean;
}

/** How a host reports a thrown command; `tools jev` and `tools control` each pass their own. */
export type ConfigFailure = (error: unknown, context?: Record<string, unknown>) => void;

/**
 * One saved-defaults command, registered by every tool that reads those defaults. Jev and control
 * are one system with one settings file, so they must not grow two ways to edit it.
 */
export function registerConfig(program: Command, fail: ConfigFailure): void {
    const config = program.command("config").description("Saved Jev and control defaults: show, set, clear");

    config
        .command("show", { isDefault: true })
        .description("Every setting with its current value and where that value comes from")
        .option("--json", "Machine-readable output")
        .action(async (options: ConfigOptions) => {
            try {
                await showConfig(options);
            } catch (error) {
                fail(error, { command: "config show" });
            }
        });

    config
        .command("set")
        .description("Save a default, so the matching flag is no longer needed")
        .argument("[key]", `One of: ${JEV_SETTINGS.map((spec) => spec.key).join(", ")}`)
        .argument("[value]")
        .action(async (key: string | undefined, value: string | undefined) => {
            try {
                await setConfig(key, value);
            } catch (error) {
                fail(error, { command: "config set" });
            }
        });

    config
        .command("unset")
        .description("Clear a saved default and fall back to the built-in one")
        .argument("<key>", `One of: ${JEV_SETTINGS.map((spec) => spec.key).join(", ")}`)
        .action(async (key: string) => {
            try {
                await unsetConfig(key);
            } catch (error) {
                fail(error, { command: "config unset" });
            }
        });
}

function savedValue(settings: JevSettings, key: JevSettingKey): string | undefined {
    const value = settingAt(settings, key);
    return value === undefined ? undefined : String(value);
}

async function showConfig(options: ConfigOptions): Promise<void> {
    const settings = await loadJevSettings();
    if (options.json === true) {
        out.result({
            file: jevSettingsPath(),
            settings,
            effective: Object.fromEntries(
                JEV_SETTINGS.map((spec) => [spec.key, savedValue(settings, spec.key) ?? spec.fallback])
            ),
        });
        return;
    }

    renderCliHeader("Saved defaults", "a flag always wins over a saved value");
    const table = createBoxTable(["SETTING", "VALUE", "SOURCE", "OPTIONS", "WHAT IT DOES"]);
    for (const spec of JEV_SETTINGS) {
        const saved = savedValue(settings, spec.key);
        table.push([
            pc.white(spec.key),
            pc.bold(saved ?? spec.fallback),
            saved === undefined ? formatDotStatus("dim", "built-in") : formatDotStatus("ok", "saved"),
            truncateDisplay(spec.values ? spec.values.join(" | ") : "any", 22),
            truncateDisplay(spec.describe, 46),
        ]);
    }

    out.println(table.toString());
    out.println(pc.dim(`  ${jevSettingsPath()}`));
    out.println(pc.dim(`  ${suggestCommand("tools jev config set", { add: ["provider", "typesafe"] })}`));
}

async function pickSpec(): Promise<SettingSpec | null> {
    const chosen = await p.select({
        message: "Which default?",
        options: JEV_SETTINGS.map((spec) => ({ value: spec.key, label: spec.key, hint: spec.describe })),
    });
    if (p.isCancel(chosen)) {
        return null;
    }

    return JEV_SETTINGS.find((spec) => spec.key === chosen) ?? null;
}

async function askValue(spec: SettingSpec): Promise<string | null> {
    if (spec.values) {
        const chosen = await p.select({
            message: `${spec.key}?`,
            options: spec.values.map((value) => ({ value, label: value })),
        });
        return p.isCancel(chosen) ? null : String(chosen);
    }

    const typed = await p.text({ message: `${spec.key}?`, placeholder: spec.fallback });
    return p.isCancel(typed) || typed.length === 0 ? null : typed;
}

async function setConfig(key: string | undefined, value: string | undefined): Promise<void> {
    if (key === undefined || value === undefined) {
        if (!isInteractive()) {
            ui.err("jev config set needs a key and a value.");
            ui.info(suggestCommand("tools jev config set", { add: ["provider", "typesafe"] }));
            ui.info(`Keys: ${JEV_SETTINGS.map((spec) => spec.key).join(", ")}`);
            process.exitCode = 1;
            return;
        }

        const spec = key === undefined ? await pickSpec() : JEV_SETTINGS.find((item) => item.key === key);
        if (!spec) {
            ui.warn("Nothing chosen.");
            return;
        }

        const chosen = value ?? (await askValue(spec));
        if (chosen === null) {
            ui.warn("Nothing chosen.");
            return;
        }

        await save(spec.key, chosen);
        return;
    }

    const known = parseSettingKey(key);
    if (!known) {
        ui.err(`Unknown setting "${key}".`);
        ui.info(`Keys: ${JEV_SETTINGS.map((spec) => spec.key).join(", ")}`);
        process.exitCode = 1;
        return;
    }

    await save(known, value);
}

async function save(key: JevSettingKey, value: string): Promise<void> {
    const spec = JEV_SETTINGS.find((item) => item.key === key);
    if (spec?.values && !spec.values.includes(value)) {
        ui.err(`${key} must be one of: ${spec.values.join(", ")}`);
        process.exitCode = 1;
        return;
    }

    await setJevSetting(key, value);
    ui.ok(`${key} = ${value}`);
    ui.dim(`  ${jevSettingsPath()}`);
}

async function unsetConfig(key: string): Promise<void> {
    const known = parseSettingKey(key);
    if (!known) {
        ui.err(`Unknown setting "${key}".`);
        ui.info(`Keys: ${JEV_SETTINGS.map((spec) => spec.key).join(", ")}`);
        process.exitCode = 1;
        return;
    }

    const spec = JEV_SETTINGS.find((item) => item.key === known);
    await unsetJevSetting(known);
    ui.ok(`${known} cleared; the built-in default (${spec?.fallback}) applies again`);
}
