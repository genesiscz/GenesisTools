import { ProfileStore } from "@app/cmux/lib/store";
import { out } from "@app/logger";
import type { Command } from "commander";

export function registerPathCommand(parent: Command): void {
    parent
        .command("path [name]")
        .description("Print the absolute path of a profile (or the profiles directory if no name)")
        .action((name: string | undefined) => {
            const store = new ProfileStore();
            if (!name) {
                out.println(store.getProfilesDir());
                return;
            }
            out.println(store.pathFor(name));
        });
}
