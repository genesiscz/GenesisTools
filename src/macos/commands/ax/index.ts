import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Command } from "commander";

export function registerAxCommand(program: Command): void {
    const ax = new Command("ax");

    ax.description("Accessibility API — interact with native app UI (delegates to `tools ax`)")
        .allowUnknownOption(true)
        .allowExcessArguments(true)
        .action((_opts, cmd) => {
            const axIndex = join(import.meta.dir, "..", "..", "..", "ax", "index.ts");
            const passthrough = cmd.args as string[];
            const r = spawnSync("bun", ["run", axIndex, ...passthrough], {
                stdio: "inherit",
                encoding: "utf-8",
            });
            process.exit(r.status ?? 1);
        });

    program.addCommand(ax);
}
