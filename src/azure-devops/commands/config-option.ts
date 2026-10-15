import { setConfigFlag } from "@app/azure-devops/config";
import { CONFIG_ENV_VAR, CONFIG_FLAG } from "@app/azure-devops/lib/config-path";
import type { Command } from "commander";

/** The global --config option. Its value is kept for the run, before the action of any command. */
export function registerConfigOption(program: Command): void {
    program
        .option(
            `${CONFIG_FLAG} <path>`,
            `Path of the Azure DevOps config.json (env: ${CONFIG_ENV_VAR}). Default: search for .claude/azure/config.json from the working directory.`
        )
        .hook("preAction", (command) => {
            setConfigFlag(command.opts<{ config?: string }>().config);
        });
}
