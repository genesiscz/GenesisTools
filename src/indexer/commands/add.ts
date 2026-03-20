import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseVariadic } from "@app/utils/cli/variadic";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { IndexerManager } from "../lib/manager";
import type { IndexConfig } from "../lib/types";

interface AddOptions {
    name?: string;
    type?: "code" | "files" | "mail" | "chat";
    chunking?: "ast" | "line" | "auto";
    provider?: string;
    storage?: "sqlite" | "orama" | "turbopuffer";
    watch?: boolean;
    ignore?: string[];
    include?: string[];
}

function autoDetectType(absPath: string): "code" | "files" {
    const hasPackageJson = existsSync(resolve(absPath, "package.json"));
    const hasGit = existsSync(resolve(absPath, ".git"));

    if (hasPackageJson || hasGit) {
        return "code";
    }

    return "files";
}

export function registerAddCommand(program: Command): void {
    program
        .command("add")
        .description("Add and index a directory")
        .argument("<path>", "Path to directory to index")
        .option("--name <name>", "Index name (default: directory basename)")
        .option("--type <type>", "Index type: code, files, mail, chat (default: auto-detect)")
        .option("--chunking <mode>", "Chunking strategy: ast, line, auto (default: auto)")
        .option("--provider <name>", "Embedding provider")
        .option("--storage <driver>", "Storage driver: sqlite, orama, turbopuffer (default: sqlite)")
        .option("--watch", "Enable watch mode after indexing")
        .option("--ignore <patterns>", "Additional ignore patterns (comma-separated)", parseVariadic)
        .option("--include <suffixes>", "File suffixes to include (comma-separated)", parseVariadic)
        .action(async (path: string, opts: AddOptions) => {
            const absPath = resolve(path);

            if (!existsSync(absPath)) {
                p.log.error(`Path does not exist: ${absPath}`);
                process.exit(1);
            }

            const name = opts.name ?? basename(absPath);
            const type = opts.type ?? autoDetectType(absPath);

            p.intro(pc.bgCyan(pc.white(" indexer add ")));
            p.log.info(`Path: ${pc.dim(absPath)}`);
            p.log.info(`Name: ${pc.bold(name)}`);
            p.log.info(`Type: ${type}`);

            const config: IndexConfig = {
                name,
                baseDir: absPath,
                type,
                respectGitIgnore: type === "code",
                chunking: opts.chunking ?? "auto",
                ignoredPaths: opts.ignore,
                includedSuffixes: opts.include,
            };

            if (opts.provider) {
                config.embedding = { provider: opts.provider };
            }

            if (opts.storage) {
                config.storage = { driver: opts.storage };
            }

            if (opts.watch) {
                config.watch = { enabled: true };
            }

            const spinner = p.spinner();
            spinner.start("Indexing...");

            try {
                const manager = await IndexerManager.load();
                const indexer = await manager.addIndex(config);
                const stats = indexer.stats;

                spinner.stop("Indexing complete");

                p.log.success(
                    `Indexed ${pc.bold(String(stats.totalFiles))} files, ` +
                        `${pc.bold(String(stats.totalChunks))} chunks`
                );

                if (opts.watch) {
                    p.log.info("Watch mode enabled. Press Ctrl+C to stop.");
                    indexer.startWatch();

                    process.on("SIGINT", async () => {
                        indexer.stopWatch();
                        await manager.close();
                        process.exit(0);
                    });

                    // Keep process alive
                    await new Promise(() => {});
                } else {
                    await manager.close();
                }
            } catch (err) {
                spinner.stop("Indexing failed");
                p.log.error(err instanceof Error ? err.message : String(err));
                process.exit(1);
            }

            p.outro("Done");
        });
}
