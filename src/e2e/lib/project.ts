import { type E2eProject, loadE2eProject } from "@genesiscz/utils/e2e/project";
import type { Command } from "commander";

export interface ProjectOptions {
    config?: string;
}

/** Adds `--config`: the project's `e2e.config.ts`; default the nearest one at or above the working folder. */
export function withConfig(command: Command): Command {
    return command.option(
        "--config <file>",
        "the project's e2e.config.ts (default: the nearest e2e.config.ts or e2e/e2e.config.ts upward)"
    );
}

export function loadProject(options: ProjectOptions): Promise<E2eProject> {
    return loadE2eProject({ config: options.config, cwd: process.cwd() });
}

/** `--env KEY=VALUE` pairs as an object; a pair without `=` is an error. */
export function parseEnvPairs(pairs: string[] | undefined): Record<string, string> {
    const parsed: Record<string, string> = {};

    for (const pair of pairs ?? []) {
        const index = pair.indexOf("=");

        if (index < 1) {
            throw new Error(`--env takes KEY=VALUE, not "${pair}"`);
        }

        parsed[pair.slice(0, index)] = pair.slice(index + 1);
    }

    return parsed;
}
