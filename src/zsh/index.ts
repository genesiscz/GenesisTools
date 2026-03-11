#!/usr/bin/env bun

import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";
import { formatTable } from "@app/utils/table.ts";
import { Storage } from "@app/utils/storage/storage.ts";
import { ALL_FEATURES, getFeature, getFeatureNames } from "./features/index.ts";
import type { ZshConfig } from "./features/types.ts";
import { generateHookScript, writeHookFile } from "./lib/hook-generator.ts";
import { getShellRcPaths, installHook, isInstalled, uninstallHook } from "./lib/shell-rc.ts";

const storage = new Storage("zsh");

async function loadConfig(): Promise<ZshConfig> {
    const config = await storage.getConfig<ZshConfig>();
    return {
        enabled: config?.enabled ?? [],
        hookMode: config?.hookMode ?? "static",
    };
}

async function saveConfig(config: ZshConfig): Promise<void> {
    await storage.setConfig(config);
}

const program = new Command();

program
    .name("zsh")
    .description("Shell enhancement manager with toggleable features")
    .version("1.0.0")
    .showHelpAfterError(true);

program
    .command("install")
    .description("Install shell hooks into rc files")
    .action(async () => {
        p.intro(pc.bgCyan(pc.black(" zsh install ")));
        const rcPaths = getShellRcPaths();

        if (rcPaths.length === 0) {
            p.log.error("No shell rc files found (~/.zshrc, ~/.bashrc, ~/.bash_profile)");
            process.exit(1);
        }

        const alreadyInstalled = rcPaths.filter((rc) => isInstalled(rc));

        if (alreadyInstalled.length > 0) {
            const config = await loadConfig();
            p.log.info(`Already installed in: ${alreadyInstalled.map((rc) => pc.bold(rc)).join(", ")}`);
            p.log.info(`Hook mode: ${pc.bold(config.hookMode)}`);
            p.log.info(`Enabled features: ${config.enabled.length > 0 ? config.enabled.join(", ") : pc.dim("(none)")}`);

            const action = await p.select({
                message: "What would you like to do?",
                options: [
                    { value: "reinstall", label: "Reinstall (same mode)" },
                    { value: "switch", label: "Switch hook mode" },
                    { value: "uninstall", label: "Uninstall" },
                    { value: "cancel", label: pc.dim("Cancel") },
                ],
            });

            if (p.isCancel(action) || action === "cancel") {
                p.cancel("Cancelled");
                return;
            }

            if (action === "uninstall") {
                for (const rc of rcPaths) {
                    uninstallHook(rc);
                }

                p.log.success("Hooks removed from all rc files");
                return;
            }

            if (action === "switch") {
                const newMode = await p.select({
                    message: "Hook mode",
                    options: [
                        {
                            value: "static" as const,
                            label: "Static",
                            hint: "~1ms startup, regenerates hook.sh on enable/disable",
                        },
                        {
                            value: "dynamic" as const,
                            label: "Dynamic",
                            hint: "~1s startup (spawns bun), no regeneration needed",
                        },
                    ],
                });

                if (p.isCancel(newMode)) {
                    p.cancel("Cancelled");
                    return;
                }

                config.hookMode = newMode;
                await saveConfig(config);

                for (const rc of rcPaths) {
                    if (isInstalled(rc)) {
                        installHook(rc, newMode);
                    }
                }

                if (newMode === "static") {
                    await writeHookFile(config);
                }

                p.log.success(`Switched to ${pc.bold(newMode)} mode`);
                return;
            }

            // reinstall
            for (const rc of alreadyInstalled) {
                installHook(rc, config.hookMode);
            }

            if (config.hookMode === "static") {
                await writeHookFile(config);
            }

            p.log.success("Reinstalled");
            return;
        }

        // Fresh install
        const selectedRcs = await p.multiselect({
            message: "Select shell rc files to install into",
            options: rcPaths.map((rc) => ({
                value: rc,
                label: rc,
            })),
            initialValues: rcPaths,
        });

        if (p.isCancel(selectedRcs)) {
            p.cancel("Cancelled");
            return;
        }

        const hookMode = await p.select({
            message: "Hook mode",
            options: [
                {
                    value: "static" as const,
                    label: "Static",
                    hint: "~1ms startup, regenerates hook.sh on enable/disable",
                },
                {
                    value: "dynamic" as const,
                    label: "Dynamic",
                    hint: "~1s startup (spawns bun), no regeneration needed",
                },
            ],
        });

        if (p.isCancel(hookMode)) {
            p.cancel("Cancelled");
            return;
        }

        const featureOptions = ALL_FEATURES.map((f) => ({
            value: f.name,
            label: f.name,
            hint: f.description + (f.shellOnly ? ` (${f.shellOnly} only)` : ""),
        }));

        const selectedFeatures = await p.multiselect({
            message: "Select features to enable",
            options: featureOptions,
            initialValues: ALL_FEATURES.map((f) => f.name),
            required: false,
        });

        if (p.isCancel(selectedFeatures)) {
            p.cancel("Cancelled");
            return;
        }

        const config: ZshConfig = {
            enabled: selectedFeatures,
            hookMode,
        };

        await saveConfig(config);

        if (hookMode === "static") {
            await writeHookFile(config);
        }

        for (const rc of selectedRcs) {
            installHook(rc, hookMode);
        }

        p.log.success(`Installed into ${selectedRcs.length} rc file(s) with ${selectedFeatures.length} feature(s)`);
        p.log.info("Restart your shell or run: " + pc.bold("source ~/.zshrc"));
    });

program
    .command("uninstall")
    .description("Remove shell hooks from all rc files")
    .action(async () => {
        const rcPaths = getShellRcPaths();
        let removed = 0;

        for (const rc of rcPaths) {
            if (isInstalled(rc)) {
                uninstallHook(rc);
                removed++;
                p.log.step(`Removed from ${rc}`);
            }
        }

        if (removed === 0) {
            p.log.info("No hooks found in any rc files");
        } else {
            p.log.success(`Removed hooks from ${removed} file(s)`);
        }
    });

program
    .command("enable <feature>")
    .description("Enable a feature")
    .action(async (featureName: string) => {
        const feature = getFeature(featureName);

        if (!feature) {
            p.log.error(`Unknown feature: ${pc.bold(featureName)}`);
            p.log.info(`Available: ${getFeatureNames().join(", ")}`);
            process.exit(1);
        }

        const config = await loadConfig();

        if (config.enabled.includes(featureName)) {
            p.log.info(`${pc.bold(featureName)} is already enabled`);
            return;
        }

        config.enabled.push(featureName);
        await saveConfig(config);

        if (config.hookMode === "static") {
            await writeHookFile(config);
            p.log.success(`Enabled ${pc.bold(featureName)} and regenerated hook.sh`);
        } else {
            p.log.success(`Enabled ${pc.bold(featureName)}`);
        }
    });

program
    .command("disable <feature>")
    .description("Disable a feature")
    .action(async (featureName: string) => {
        const feature = getFeature(featureName);

        if (!feature) {
            p.log.error(`Unknown feature: ${pc.bold(featureName)}`);
            p.log.info(`Available: ${getFeatureNames().join(", ")}`);
            process.exit(1);
        }

        const config = await loadConfig();
        const idx = config.enabled.indexOf(featureName);

        if (idx === -1) {
            p.log.info(`${pc.bold(featureName)} is already disabled`);
            return;
        }

        config.enabled.splice(idx, 1);
        await saveConfig(config);

        if (config.hookMode === "static") {
            await writeHookFile(config);
            p.log.success(`Disabled ${pc.bold(featureName)} and regenerated hook.sh`);
        } else {
            p.log.success(`Disabled ${pc.bold(featureName)}`);
        }
    });

program
    .command("list")
    .description("List all available features")
    .action(async () => {
        const config = await loadConfig();

        const rows = ALL_FEATURES.map((f) => {
            const enabled = config.enabled.includes(f.name);
            const status = enabled ? pc.green("enabled") : pc.dim("disabled");
            const shell = f.shellOnly ?? "both";
            return [f.name, f.description, status, shell];
        });

        console.log(formatTable(rows, ["Name", "Description", "Status", "Shell"]));
    });

program
    .command("hook")
    .description("Print hook script to stdout (for dynamic mode)")
    .action(async () => {
        const config = await loadConfig();
        process.stdout.write(generateHookScript(config));
    });

async function main(): Promise<void> {
    await program.parseAsync(process.argv);
}

main().catch((err) => {
    p.log.error(`${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
