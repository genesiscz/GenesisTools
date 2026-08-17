import { chmod, copyFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { suggestCommand } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";
import { resolveSelectors } from "../lib/discover.ts";
import {
    findProjectRoot,
    inferProject,
    SCRIPT_NAME_RE,
    type ScriptEntry,
    scriptPaths,
    upsertEntry,
} from "../lib/journal.ts";
import { type BoundTool, bindNames, renderScriptModule, renderToolsModule } from "../lib/scaffold.ts";
import { commitStore, ensureStoreScaffold, readStoreConfig, storeRemoteUrl, trashDir } from "../lib/store.ts";

interface CreateOptions {
    import?: string[];
    description?: string;
    tag?: string[];
    project?: string;
    gated?: boolean;
    refresh?: boolean;
    force?: boolean;
    dryRun?: boolean;
}

export function registerCreate(program: Command): void {
    program
        .command("create <name>")
        .description("Scaffold persisted/<name>/ with typed bindings for the imported tools")
        .option("-i, --import <selectors...>", "Tool selectors, e.g. 'chrome-devtools-mcp.*' '*.handoff_*'")
        .option("-d, --description <text>", "What this script is for")
        .option("-t, --tag <tags...>", "Tags for filtering later")
        .option("-p, --project <name>", "Project label (defaults to the inferred repo name)")
        .option("--gated", "Hide from `list` outside the current project tree (`run` still works anywhere)")
        .option("--refresh", "Re-probe servers before binding")
        .option("--force", "Replace an existing script of this name (the old one is copied to trash/ first)")
        .option("--dry-run", "Show which tools would bind, write nothing")
        .action(async (name: string, opts: CreateOptions) => {
            if (!SCRIPT_NAME_RE.test(name)) {
                throw new Error(
                    `Invalid script name '${name}'. Use letters, digits, dash, underscore; start with a letter.`
                );
            }

            const { dir: scriptDir, file, toolsFile } = scriptPaths(name);

            if (!opts.force && !opts.dryRun && (await Bun.file(file).exists())) {
                throw new Error(
                    `${file} already exists. Pass --force to replace it (a copy goes to trash/), or pick another name.`
                );
            }

            let bound: BoundTool[] = [];
            let errors: { server: string; error: string }[] = [];

            if (opts.import && opts.import.length > 0) {
                // --dry-run promises "write nothing"; that includes the registry and tools caches.
                const resolved = await resolveSelectors(opts.import, { refresh: opts.refresh, persist: !opts.dryRun });
                errors = resolved.errors;

                if (resolved.matched.length === 0) {
                    const detail =
                        errors.length > 0
                            ? ` Servers that failed to start: ${errors.map((e) => e.server).join(", ")}.`
                            : "";
                    throw new Error(
                        `No tools matched ${opts.import.join(", ")}.${detail} Try '${suggestCommand("tools scripts", { replaceCommand: ["tools"] })}' to see what exists.`
                    );
                }

                bound = bindNames(resolved.matched);
            }

            const servers = [...new Set(bound.map((b) => b.server))];

            if (opts.dryRun) {
                ui.header(`dry run — ${bound.length} binding(s) across ${servers.length} server(s), nothing written`);

                for (const b of bound) {
                    ui.raw(`  ${b.fnName.padEnd(34)} ${pc.dim(`${b.server}.${b.tool.name}`)}`);
                }

                for (const e of errors) {
                    ui.err(`${e.server}: ${e.error.slice(0, 160)}`);
                }
                return;
            }

            await ensureStoreScaffold();
            logger.debug(
                {
                    name,
                    selectors: opts.import ?? [],
                    bound: bound.length,
                    servers,
                    force: Boolean(opts.force),
                    gated: Boolean(opts.gated),
                },
                "scripts create"
            );

            // Never destroy a hand-edited script: the files being OVERWRITTEN
            // get a trash copy first. Sidecars are not backed up because they
            // are not touched — they stay in place untouched.
            if (opts.force && (await Bun.file(file).exists())) {
                const stamp = new Date().toISOString().replace(/[:.]/g, "-");
                await mkdir(trashDir(), { recursive: true });

                for (const [src, label] of [
                    [file, `${name}.ts`],
                    [toolsFile, `${name}.tools.ts`],
                ] as const) {
                    if (await Bun.file(src).exists()) {
                        await copyFile(src, join(trashDir(), `${stamp}-${label}`));
                    }
                }

                ui.dim(`backed up previous ${name} to trash/${stamp}-${name}.ts`);
            }

            const cwd = process.cwd();
            const project = opts.project ?? inferProject(cwd);
            const gateDir = opts.gated ? (findProjectRoot(cwd) ?? cwd) : undefined;
            const now = new Date().toISOString();

            await mkdir(scriptDir, { recursive: true });

            if (bound.length > 0) {
                await Bun.write(toolsFile, renderToolsModule(bound, opts.import ?? [], now));
            } else if (opts.force && (await Bun.file(toolsFile).exists())) {
                // Force-recreating without --import: the old bindings file was
                // copied to trash above; leaving the original would advertise
                // generated bindings the new script no longer has.
                await unlink(toolsFile);
            }

            await Bun.write(
                file,
                renderScriptModule({
                    name,
                    description: opts.description,
                    servers,
                    bound,
                    selectors: opts.import ?? [],
                    createdFrom: cwd,
                    project,
                    tags: opts.tag ?? [],
                })
            );
            await chmod(file, 0o755);

            const entry: ScriptEntry = {
                name,
                file,
                description: opts.description,
                imports: opts.import ?? [],
                tools: bound.map((b) => `${b.server}.${b.tool.name}`),
                servers,
                tags: opts.tag ?? [],
                project,
                gateDir,
                createdFrom: cwd,
                createdAt: now,
                updatedAt: now,
                runs: 0,
            };
            await upsertEntry(entry);
            await commitStore(`feat: create ${name}`);

            ui.ok(`created ${bound.length} binding(s) across ${servers.length} server(s)`);
            ui.kv("script", file);

            if (bound.length > 0) {
                const regenHint = suggestCommand("tools scripts", { replaceCommand: ["regen", name] });
                ui.kv("bindings", `${toolsFile} ${pc.dim(`(generated, regenerate with '${regenHint}')`)}`);
            }

            if (gateDir) {
                ui.kv("gated to", gateDir);
            }

            ui.kv("run", suggestCommand("tools scripts", { replaceCommand: ["run", name] }));

            for (const e of errors) {
                ui.err(`${e.server} did not respond: ${e.error.slice(0, 160)}`);
            }

            // One-line standing offer until the user decides either way.
            const storeConfig = await readStoreConfig();

            if (!storeConfig.remote && !(await storeRemoteUrl())) {
                const setUp = suggestCommand("tools scripts", { replaceCommand: ["remote", "<url>"] });
                const decline = suggestCommand("tools scripts", { replaceCommand: ["remote", "--none"] });
                ui.dim(`tip: version this store off-machine — ${setUp} (or: ${decline})`);
            }

            out.print(scriptDir);
        });
}
