import { suggestCommand } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import type { Command } from "commander";
import {
    ensureStoreScaffold,
    readStoreConfig,
    runGit,
    setStoreRemote,
    storeRemoteUrl,
    storeRoot,
    writeStoreConfig,
} from "../lib/store.ts";

/** Raw git against the store, so nobody has to remember `git -C ~/.genesis-tools/scripts`. */
export function registerGit(program: Command): void {
    program
        .command("git [args...]")
        .description("Run a git command inside the script store. Pass git flags after '--', e.g. git -- log --oneline")
        .allowExcessArguments(true)
        .action(async (args: string[]) => {
            await ensureStoreScaffold();
            const proc = Bun.spawn(["git", "-C", storeRoot(), ...args], {
                stdin: "inherit",
                stdout: "inherit",
                stderr: "inherit",
            });
            process.exitCode = await proc.exited;
        });
}

interface RemoteOptions {
    none?: boolean;
    autoPush?: string;
}

function parseAutoPush(value: string | undefined): boolean | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (value === "on" || value === "off") {
        return value === "on";
    }

    throw new Error(`--auto-push must be 'on' or 'off', got '${value}'.`);
}

/**
 * Set up (or inspect) off-machine history for the store, and persist the
 * decision in the store config so the post-create offer stops once decided.
 */
export function registerRemote(program: Command): void {
    program
        .command("remote [url]")
        .description(
            "Show or set the store's git remote. With a url: adds/updates origin, pushes, remembers the decision."
        )
        .option("--none", "No remote wanted — remember the decision and stop offering")
        .option("--auto-push <on|off>", "Push after every store commit (persisted)")
        .action(async (url: string | undefined, opts: RemoteOptions) => {
            const autoPush = parseAutoPush(opts.autoPush);
            const config = await readStoreConfig();

            if (opts.none) {
                if (url) {
                    throw new Error("Pass either a url or --none, not both.");
                }

                config.remote = { declined: true, decidedAt: new Date().toISOString() };
                await writeStoreConfig(config);
                ui.ok("remembered: no remote for the script store (the create-time offer stops)");
                return;
            }

            if (!url) {
                const current = await storeRemoteUrl();

                if (current) {
                    ui.kv("origin", current);
                } else {
                    ui.raw(config.remote?.declined ? "no remote (declined by choice)" : "no remote configured");
                }

                ui.kv("auto-push", config.remote?.autoPush ? "on" : "off", 10);

                if (autoPush !== undefined) {
                    config.remote = {
                        ...(config.remote ?? { decidedAt: new Date().toISOString() }),
                        autoPush,
                        decidedAt: new Date().toISOString(),
                    };
                    await writeStoreConfig(config);
                    ui.ok(`auto-push ${autoPush ? "on" : "off"} (persisted)`);
                } else if (!current && !config.remote?.declined) {
                    const setUp = suggestCommand("tools scripts", { replaceCommand: ["remote", "<url>"] });
                    const decline = suggestCommand("tools scripts", { replaceCommand: ["remote", "--none"] });
                    ui.dim(`set one up: ${setUp}   (or: ${decline})`);
                }

                return;
            }

            const result = await setStoreRemote(url);
            ui.ok(`${result.action} origin → ${url}`);

            const push = await runGit(storeRoot(), ["push", "-u", "origin", "main"]);

            if (push.exitCode === 0) {
                ui.ok("pushed main with upstream tracking");
            } else {
                ui.warn(`initial push failed: ${push.stderr.split("\n")[0]}`);
                const retry = suggestCommand("tools scripts", {
                    replaceCommand: ["git", "--", "push", "-u", "origin", "main"],
                });
                ui.dim(`retry later with: ${retry}`);
            }

            config.remote = {
                url,
                declined: false,
                autoPush: autoPush ?? config.remote?.autoPush ?? false,
                decidedAt: new Date().toISOString(),
            };
            await writeStoreConfig(config);
            ui.kv("auto-push", config.remote.autoPush ? "on" : "off", 10);
        });
}
