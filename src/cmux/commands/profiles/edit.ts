import { existsSync } from "node:fs";
import { ProfileNotFoundError, ProfileStore } from "@app/cmux/lib/store";
import type { Command } from "commander";

export function registerEditCommand(parent: Command): void {
    parent
        .command("edit <name>")
        .description("Open the profile JSON in $EDITOR")
        .action(async (name: string) => {
            const store = new ProfileStore();
            const path = store.pathFor(name);
            if (!existsSync(path)) {
                throw new ProfileNotFoundError(name, path);
            }

            const editor = pickEditor();
            const proc = Bun.spawn([editor.bin, ...editor.args, path], { stdio: ["inherit", "inherit", "inherit"] });
            const exitCode = await proc.exited;
            if (exitCode !== 0) {
                throw new Error(`${editor.bin} exited with code ${exitCode}`);
            }
        });
}

function pickEditor(): { bin: string; args: string[] } {
    const fromEnv = process.env.VISUAL || process.env.EDITOR;
    if (fromEnv) {
        const parts = fromEnv.split(/\s+/).filter(Boolean);
        if (parts.length > 0) {
            return { bin: parts[0], args: parts.slice(1) };
        }
    }
    return { bin: "vi", args: [] };
}
