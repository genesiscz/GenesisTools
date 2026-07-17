import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Command } from "commander";

export function registerControlCommand(program: Command): void {
    const control = new Command("control");

    control
        .description("macOS UI automation — element control + recording (delegates to `tools control`)")
        .allowUnknownOption(true)
        .allowExcessArguments(true)
        .action((_opts, cmd) => {
            const controlIndex = join(import.meta.dir, "..", "..", "..", "control", "index.ts");
            const passthrough = cmd.args as string[];
            const r = spawnSync("bun", ["run", controlIndex, ...passthrough], {
                stdio: "inherit",
                encoding: "utf-8",
            });
            process.exit(r.status ?? 1);
        });

    program.addCommand(control);
}
