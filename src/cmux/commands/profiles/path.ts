import { ProfileStore } from "@app/cmux/lib/store";
import type { Command } from "commander";

export function registerPathCommand(parent: Command): void {
    parent
        .command("path [name]")
        .description("Print the absolute path of a profile (or the profiles directory if no name)")
        .action((name: string | undefined) => {
            const store = new ProfileStore();
            if (!name) {
                console.log(store.getProfilesDir());
                return;
            }
            console.log(store.pathFor(name));
        });
}
