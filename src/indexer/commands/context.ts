import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { formatDuration } from "@app/utils/format";
import { SafeJSON } from "@app/utils/json";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import type { ContextConfig } from "../lib/context-artifacts";
import { CONFIG_FILENAME, ContextArtifactSource, loadContextConfig } from "../lib/context-artifacts";
import { IndexerManager } from "../lib/manager";
import { createProgressCallbacks } from "../lib/progress";

const CONTEXT_SUFFIX = "__context";

export function registerContextCommand(program: Command): void {
    const ctx = program.command("context").description("Manage context artifacts (.genesistoolscontext.json)");

    ctx.command("list")
        .description("List configured context artifacts and their index status")
        .argument("[index-name]", "Index name (shows all if omitted)")
        .action(async (indexName?: string) => {
            const manager = await IndexerManager.load();

            try {
                const names = indexName ? [indexName] : manager.getIndexNames();
                const baseNames = names.filter((n) => !n.endsWith(CONTEXT_SUFFIX));

                if (baseNames.length === 0) {
                    p.log.info("No indexes configured. Run: tools indexer add <path>");
                    return;
                }

                p.intro(pc.bgCyan(pc.white(" context artifacts ")));

                for (const name of baseNames) {
                    const indexes = manager.listIndexes();
                    const meta = indexes.find((m) => m.name === name);

                    if (!meta) {
                        p.log.warn(`Index "${name}" not found`);
                        continue;
                    }

                    const config = await loadContextConfig(meta.config.baseDir);

                    if (!config?.artifacts?.length) {
                        p.log.info(`${pc.bold(name)}: no ${CONFIG_FILENAME} found in ${meta.config.baseDir}`);
                        continue;
                    }

                    p.log.step(pc.bold(name));

                    const contextIndexName = `${name}${CONTEXT_SUFFIX}`;
                    const contextMeta = indexes.find((m) => m.name === contextIndexName);
                    const hasContextIndex = !!contextMeta;

                    for (const artifact of config.artifacts) {
                        const absPath = resolve(meta.config.baseDir, artifact.path);
                        const exists = existsSync(absPath);
                        let status = exists ? "new" : "missing";

                        if (hasContextIndex && exists) {
                            const source = new ContextArtifactSource(meta.config.baseDir);
                            const entries = await source.scan();
                            const entry = entries.find((e) => e.id === `context::${artifact.name}`);

                            if (entry) {
                                status = "indexed";
                            }
                        }

                        const statusColor =
                            status === "indexed"
                                ? pc.green(status)
                                : status === "missing"
                                  ? pc.red(status)
                                  : pc.yellow(status);

                        p.log.info(
                            `  ${pc.bold(artifact.name)} ${pc.dim(artifact.path)} — ${artifact.description} [${statusColor}]`
                        );
                    }
                }

                p.outro("Done");
            } finally {
                await manager.close();
            }
        });

    ctx.command("add")
        .description("Add a context artifact to .genesistoolscontext.json")
        .argument("<index-name>", "Index name")
        .requiredOption("--name <name>", "Artifact name")
        .requiredOption("--path <path>", "Path to file or directory (relative to index baseDir)")
        .requiredOption("--description <desc>", "Human-readable description")
        .option("--sync", "Sync context index after adding")
        .action(
            async (indexName: string, opts: { name: string; path: string; description: string; sync?: boolean }) => {
                const manager = await IndexerManager.load();

                try {
                    const indexes = manager.listIndexes();
                    const meta = indexes.find((m) => m.name === indexName);

                    if (!meta) {
                        p.log.error(`Index "${indexName}" not found`);
                        process.exitCode = 1;
                        return;
                    }

                    const configPath = join(meta.config.baseDir, CONFIG_FILENAME);
                    const absArtifactPath = resolve(meta.config.baseDir, opts.path);

                    if (!existsSync(absArtifactPath)) {
                        p.log.error(`Artifact path does not exist: ${absArtifactPath}`);
                        process.exitCode = 1;
                        return;
                    }

                    let config: ContextConfig;

                    if (existsSync(configPath)) {
                        const raw = readFileSync(configPath, "utf-8");
                        config = SafeJSON.parse(raw) as ContextConfig;
                    } else {
                        config = {};
                    }

                    if (!config.artifacts) {
                        config.artifacts = [];
                    }

                    const existing = config.artifacts.find((a) => a.name.toLowerCase() === opts.name.toLowerCase());

                    if (existing) {
                        p.log.error(`Artifact "${opts.name}" already exists in ${CONFIG_FILENAME}`);
                        process.exitCode = 1;
                        return;
                    }

                    config.artifacts.push({
                        name: opts.name,
                        path: opts.path,
                        description: opts.description,
                    });

                    writeFileSync(configPath, `${SafeJSON.stringify(config, null, 2)}\n`);
                    p.log.success(`Added artifact "${opts.name}" to ${CONFIG_FILENAME}`);

                    if (opts.sync) {
                        await syncContextIndex(manager, indexName);
                    }
                } finally {
                    await manager.close();
                }
            }
        );

    ctx.command("remove")
        .description("Remove a context artifact from .genesistoolscontext.json")
        .argument("<index-name>", "Index name")
        .requiredOption("--name <name>", "Artifact name to remove")
        .option("--sync", "Sync context index after removing")
        .action(async (indexName: string, opts: { name: string; sync?: boolean }) => {
            const manager = await IndexerManager.load();

            try {
                const indexes = manager.listIndexes();
                const meta = indexes.find((m) => m.name === indexName);

                if (!meta) {
                    p.log.error(`Index "${indexName}" not found`);
                    process.exitCode = 1;
                    return;
                }

                const configPath = join(meta.config.baseDir, CONFIG_FILENAME);

                if (!existsSync(configPath)) {
                    p.log.error(`No ${CONFIG_FILENAME} found in ${meta.config.baseDir}`);
                    process.exitCode = 1;
                    return;
                }

                const raw = readFileSync(configPath, "utf-8");
                const config = SafeJSON.parse(raw) as ContextConfig;

                if (!config.artifacts?.length) {
                    p.log.error("No artifacts configured");
                    process.exitCode = 1;
                    return;
                }

                const idx = config.artifacts.findIndex((a) => a.name.toLowerCase() === opts.name.toLowerCase());

                if (idx === -1) {
                    p.log.error(`Artifact "${opts.name}" not found in ${CONFIG_FILENAME}`);
                    process.exitCode = 1;
                    return;
                }

                config.artifacts.splice(idx, 1);
                writeFileSync(configPath, `${SafeJSON.stringify(config, null, 2)}\n`);
                p.log.success(`Removed artifact "${opts.name}" from ${CONFIG_FILENAME}`);

                if (opts.sync) {
                    await syncContextIndex(manager, indexName);
                }
            } finally {
                await manager.close();
            }
        });

    ctx.command("sync")
        .description("Force re-index of context artifacts")
        .argument("[index-name]", "Index name (syncs all context indexes if omitted)")
        .action(async (indexName?: string) => {
            const manager = await IndexerManager.load();

            try {
                const names = indexName ? [indexName] : manager.getIndexNames();
                const baseNames = names.filter((n) => !n.endsWith(CONTEXT_SUFFIX));

                if (baseNames.length === 0) {
                    p.log.info("No indexes configured");
                    return;
                }

                for (const name of baseNames) {
                    await syncContextIndex(manager, name);
                }
            } finally {
                await manager.close();
            }
        });
}

async function syncContextIndex(manager: IndexerManager, parentName: string): Promise<void> {
    const contextName = `${parentName}${CONTEXT_SUFFIX}`;
    const allNames = manager.getIndexNames();

    if (!allNames.includes(contextName)) {
        p.log.warn(`No context index "${contextName}" found. It will be created when you next sync the parent index.`);
        return;
    }

    p.intro(pc.bgCyan(pc.white(` sync ${contextName} `)));
    const spinner = p.spinner();
    spinner.start("Syncing context artifacts...");

    const indexer = await manager.getIndex(contextName);
    const stats = await indexer.sync(createProgressCallbacks(spinner));

    spinner.stop("Context sync complete");

    const totalChanges = stats.chunksAdded + stats.chunksUpdated + stats.chunksRemoved;

    if (totalChanges === 0) {
        p.log.info("Context index is up to date");
    } else {
        p.log.success(
            `${stats.filesScanned} artifacts scanned, ` +
                `${pc.green(`+${stats.chunksAdded}`)} chunks added, ` +
                `${pc.red(`-${stats.chunksRemoved}`)} removed ` +
                `in ${formatDuration(stats.durationMs)}`
        );
    }
}
