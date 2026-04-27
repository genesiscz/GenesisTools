import { ProfileNotFoundError, ProfileStore } from "@app/cmux/lib/store";
import { isInteractive, suggestCommand } from "@app/utils/cli";
import { withCancel } from "@app/utils/prompts/clack/helpers";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

export function registerDeleteCommand(parent: Command): void {
    parent
        .command("delete <name>")
        .alias("rm")
        .description("Remove a saved profile")
        .option("-y, --yes", "Skip the confirmation prompt")
        .action(async (name: string, flags: { yes?: boolean }) => {
            const store = new ProfileStore();
            try {
                const summary = store.summarize(store.read(name));
                if (!flags.yes) {
                    if (!isInteractive()) {
                        console.error(
                            `Refusing to delete in non-interactive mode without --yes. ${suggestCommand(`tools cmux profiles delete ${name} --yes`)}`
                        );
                        process.exitCode = 1;
                        return;
                    }
                    const confirmed = await withCancel(
                        p.confirm({
                            message: `Delete profile "${name}" (${summary.workspaces} workspace(s))?`,
                            initialValue: false,
                        })
                    );
                    if (!confirmed) {
                        p.cancel("Aborted.");
                        return;
                    }
                }
                store.delete(name);
                console.log(`${pc.green("✓")} Deleted profile "${name}".`);
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
