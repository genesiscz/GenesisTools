import { loadMobileProject, type MobileProject } from "@genesiscz/utils/mobile/project";
import type { Command } from "commander";

export interface ProjectOptions {
    config?: string;
}

/** Adds `--config`: the project's `mobile.config.ts`; default the nearest one at or above the working folder. */
export function withConfig(command: Command): Command {
    return command.option(
        "--config <file>",
        "the project's mobile.config.ts (default: the nearest mobile.config.ts or e2e/mobile.config.ts upward)"
    );
}

export function loadProject(options: ProjectOptions): Promise<MobileProject> {
    return loadMobileProject({ config: options.config, cwd: process.cwd() });
}
