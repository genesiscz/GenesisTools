import { Command } from "commander";
import pc from "picocolors";
import { renderProfileList } from "@app/cmux/lib/format";
import { ProfileStore } from "@app/cmux/lib/store";

export function registerListCommand(parent: Command): void {
    parent
        .command("list")
        .alias("ls")
        .description("List saved cmux profiles")
        .option("--json", "Emit JSON instead of the rendered table")
        .action((opts: { json?: boolean }) => {
            const store = new ProfileStore();
            const summaries = store.list();
            if (opts.json) {
                console.log(JSON.stringify(summaries, null, 2));
                return;
            }
            console.log(renderProfileList(summaries));
            if (summaries.length > 0) {
                console.log("");
                console.log(pc.dim(`profiles dir: ${store.getProfilesDir()}`));
            }
        });
}
