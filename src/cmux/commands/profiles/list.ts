import { renderProfileList } from "@app/cmux/lib/format";
import { ProfileStore } from "@app/cmux/lib/store";
import { out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { Command } from "commander";
import pc from "picocolors";

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
                out.println(SafeJSON.stringify(summaries, null, 2));
                return;
            }
            out.println(renderProfileList(summaries));
            if (summaries.length > 0) {
                out.println("");
                out.println(pc.dim(`profiles dir: ${store.getProfilesDir()}`));
            }
        });
}
