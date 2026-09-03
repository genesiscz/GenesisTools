import { statSync } from "node:fs";
import { resolve } from "node:path";
import { parseMinReal } from "@app/macos/lib/clones/min-real";
import {
    addWatchedDirs,
    loadClonesConfig,
    removeWatchedDirs,
    setMinReal,
    setNodeModules,
} from "@app/macos/lib/clones/store";
import * as p from "@clack/prompts";
import { isInteractive, parseVariadic } from "@genesiscz/utils/cli";
import { printLn } from "@genesiscz/utils/cli/stdout";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Command } from "commander";
import pc from "picocolors";

const log = logger.child({ component: "clones:config-cmd" });

function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
}

interface ConfigOpts {
    addDir: string[];
    removeDir: string[];
    list?: boolean;
    setMinReal?: string;
    nodeModules?: string;
}

function validateExisting(paths: string[]): string[] {
    const ok: string[] = [];
    for (const raw of paths) {
        const abs = resolve(raw);
        let st: ReturnType<typeof statSync> | null = null;
        try {
            st = statSync(abs);
        } catch {
            console.error(`Skipping non-existent path: ${raw}`);
            log.warn({ path: raw }, "config add: path does not exist");
            continue;
        }

        if (!st.isDirectory()) {
            console.error(`Skipping non-directory path: ${raw}`);
            log.warn({ path: raw }, "config add: path is not a directory");
            continue;
        }

        ok.push(abs);
    }

    return ok;
}

export function createConfigCommand(): Command {
    return new Command("config")
        .description("Manage watched dirs + filters for clone scans")
        .option("--add-dir <paths>", "Add watched dir(s) (repeatable / comma list)", collect, [])
        .option("--remove-dir <paths>", "Remove watched dir(s) (repeatable / comma list)", collect, [])
        .option("--list", "Print the current config as JSON", false)
        .option("--set-min-real <bytes>", "Default min-real threshold")
        .option("--node-modules <on|off>", "Default node_modules focus mode")
        .action(async (opts: ConfigOpts) => {
            const adds = parseVariadic(opts.addDir);
            const removes = parseVariadic(opts.removeDir);
            const mutating =
                adds.length > 0 ||
                removes.length > 0 ||
                opts.setMinReal !== undefined ||
                opts.nodeModules !== undefined;

            if (!isInteractive() || mutating || opts.list) {
                // Validate BEFORE any write: a rejected --set-min-real used to
                // still apply the other mutations and print the config to
                // stdout, so a wrapper saw a partial change and a success shape
                // beside a failure exit code.
                let minReal: number | null = null;
                if (opts.setMinReal !== undefined) {
                    minReal = parseMinReal(opts.setMinReal);
                    if (minReal === null) {
                        console.error(
                            `--set-min-real must be a positive whole number of bytes, got "${opts.setMinReal}".`
                        );
                        process.exitCode = 1;
                        return;
                    }
                }

                if (adds.length > 0) {
                    const valid = validateExisting(adds);
                    if (valid.length > 0) {
                        await addWatchedDirs(valid);
                    }
                }

                if (removes.length > 0) {
                    await removeWatchedDirs(removes);
                }

                if (minReal !== null) {
                    await setMinReal(minReal);
                }

                if (opts.nodeModules !== undefined) {
                    await setNodeModules(opts.nodeModules === "on" || opts.nodeModules === "true");
                }

                await printLn(SafeJSON.stringify(await loadClonesConfig(), null, 2));
                return;
            }

            p.intro(pc.bgCyan(pc.black(" clones config ")));
            const cfg = await loadClonesConfig();
            p.log.info(
                `watched dirs:\n${cfg.watchedDirs.length ? cfg.watchedDirs.map((d) => `  ${d}`).join("\n") : "  (none)"}`
            );
            p.log.info(`minReal: ${cfg.minReal ?? "default (10 MB)"}  nodeModules: ${cfg.nodeModules ? "on" : "off"}`);

            const action = await p.select({
                message: "Action",
                options: [
                    { value: "add", label: "Add a watched dir" },
                    { value: "remove", label: "Remove a watched dir" },
                    { value: "toggle-nm", label: "Toggle node_modules focus" },
                    { value: "min-real", label: "Set min-real threshold" },
                    { value: "quit", label: "Quit (no changes)" },
                ],
            });

            if (p.isCancel(action) || action === "quit") {
                p.cancel("No changes.");
                return;
            }

            if (action === "add") {
                const dir = await p.text({ message: "Directory to add", placeholder: "/path/to/projects" });
                if (p.isCancel(dir)) {
                    p.cancel("No changes.");
                    return;
                }

                const valid = validateExisting([dir]);
                if (valid.length > 0) {
                    await addWatchedDirs(valid);
                    p.log.success(`Added ${valid[0]}`);
                }
            } else if (action === "remove") {
                if (cfg.watchedDirs.length === 0) {
                    p.log.warn("No watched dirs to remove.");
                } else {
                    const sel = await p.select({
                        message: "Remove which?",
                        options: cfg.watchedDirs.map((d) => ({ value: d, label: d })),
                    });

                    if (p.isCancel(sel)) {
                        p.cancel("No changes.");
                        return;
                    }

                    await removeWatchedDirs([sel]);
                    p.log.success(`Removed ${sel}`);
                }
            } else if (action === "toggle-nm") {
                const next = !cfg.nodeModules;
                await setNodeModules(next);
                p.log.success(`node_modules focus → ${next ? "on" : "off"}`);
            } else if (action === "min-real") {
                const v = await p.text({ message: "min-real bytes", placeholder: "10485760" });
                if (p.isCancel(v)) {
                    p.cancel("No changes.");
                    return;
                }

                const n = parseMinReal(v);
                if (n === null) {
                    p.log.error(`min-real must be a positive whole number of bytes, got "${v}".`);
                } else {
                    await setMinReal(n);
                    p.log.success(`min-real → ${n}`);
                }
            }

            p.outro("Done!");
        });
}
