import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { Command } from "commander";
import { ProfileNotFoundError, ProfileStore } from "@app/cmux/lib/store";

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
            const args = editor.args.concat([path]);
            await new Promise<void>((resolve, reject) => {
                const child = spawn(editor.bin, args, { stdio: "inherit" });
                child.on("error", reject);
                child.on("close", (code) => {
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error(`${editor.bin} exited with code ${code}`));
                    }
                });
            });
        });
}

function pickEditor(): { bin: string; args: string[] } {
    const fromEnv = process.env.VISUAL || process.env.EDITOR;
    if (fromEnv) {
        const parts = fromEnv.split(/\s+/).filter(Boolean);
        return { bin: parts[0], args: parts.slice(1) };
    }
    return { bin: "vi", args: [] };
}
