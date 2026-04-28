import { Command } from "commander";
import { renderProfileTree } from "@app/cmux/lib/format";
import { ProfileNotFoundError, ProfileStore } from "@app/cmux/lib/store";

export function registerViewCommand(parent: Command): void {
    parent
        .command("view <name>")
        .alias("show")
        .description("Show a saved profile as a rich tree")
        .option("--json", "Emit the raw profile JSON")
        .action((name: string, opts: { json?: boolean }) => {
            const store = new ProfileStore();
            try {
                const profile = store.read(name);
                if (opts.json) {
                    console.log(JSON.stringify(profile, null, 2));
                    return;
                }
                console.log(renderProfileTree(profile));
            } catch (error) {
                if (error instanceof ProfileNotFoundError) {
                    console.error(error.message);
                    process.exitCode = 1;
                    return;
                }
                throw error;
            }
        });
}
