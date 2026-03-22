import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseVariadic } from "@app/utils/cli/variadic";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { EmbeddingSetupError } from "../lib/indexer";
import { IndexerManager } from "../lib/manager";
import { getModelsForType, MODEL_REGISTRY } from "../lib/model-registry";
import { createProgressCallbacks } from "../lib/progress";
import type { IndexConfig } from "../lib/types";

interface AddOptions {
    name?: string;
    type?: "code" | "files" | "mail" | "chat";
    chunking?: "ast" | "line" | "heading" | "message" | "json" | "auto";
    model?: string;
    storage?: "sqlite" | "orama" | "turbopuffer";
    watch?: boolean;
    embed?: boolean;
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

function resolveProvider(modelId: string): string | undefined {
    const model = MODEL_REGISTRY.find((m) => m.id === modelId);

    if (!model) {
        return undefined;
    }

    return model.provider;
}

async function runInteractiveFlow(): Promise<IndexConfig | null> {
    p.intro(pc.bgCyan(pc.white(" indexer add ")));

    const indexPath = await p.text({
        message: "Path to index",
        initialValue: process.cwd(),
        validate: (val) => {
            if (!val || !existsSync(resolve(val))) {
                return "Path does not exist";
            }
        },
    });

    if (p.isCancel(indexPath)) {
        p.cancel("Cancelled");
        return null;
    }

    const absPath = resolve(indexPath);
    const detectedType = autoDetectType(absPath);

    const indexName = await p.text({
        message: "Index name",
        initialValue: basename(absPath),
        validate: (val) => {
            if (!val?.trim()) {
                return "Name is required";
            }
        },
    });

    if (p.isCancel(indexName)) {
        p.cancel("Cancelled");
        return null;
    }

    const indexType = await p.select({
        message: "Index type",
        initialValue: detectedType,
        options: [
            { value: "code" as const, label: "code", hint: "Source code with AST-aware chunking" },
            { value: "files" as const, label: "files", hint: "General files" },
            { value: "mail" as const, label: "mail", hint: "Email messages" },
            { value: "chat" as const, label: "chat", hint: "Chat history" },
        ],
    });

    if (p.isCancel(indexType)) {
        p.cancel("Cancelled");
        return null;
    }

    const enableEmbed = await p.confirm({
        message: "Enable semantic embeddings?",
        initialValue: true,
    });

    if (p.isCancel(enableEmbed)) {
        p.cancel("Cancelled");
        return null;
    }

    let selectedModel: string | undefined;

    if (enableEmbed) {
        const models = getModelsForType(indexType);

        const modelChoice = await p.select({
            message: "Embedding model",
            options: [
                ...models.map((m) => ({
                    value: m.id,
                    label: m.name,
                    hint: `${m.dimensions}-dim, ${m.provider}${m.provider === "ollama" ? " (GPU)" : m.provider === "coreml" ? " (GPU/ANE)" : ""} — ${m.description}`,
                })),
                { value: "__none__", label: "No embeddings (fulltext-only)" },
            ],
        });

        if (p.isCancel(modelChoice)) {
            p.cancel("Cancelled");
            return null;
        }

        selectedModel = modelChoice;
    }

    const provider = selectedModel ? resolveProvider(selectedModel) : undefined;

    // For Ollama models: check if pulled, offer to download
    if (provider === "ollama" && selectedModel) {
        try {
            const { AIOllamaProvider } = await import("@app/utils/ai/providers/AIOllamaProvider");
            const ollama = new AIOllamaProvider({ defaultModel: selectedModel });

            if (await ollama.isAvailable()) {
                if (!(await ollama.hasModel(selectedModel))) {
                    const pull = await p.confirm({
                        message: `Model "${selectedModel}" not found in Ollama. Download it now?`,
                        initialValue: true,
                    });

                    if (p.isCancel(pull) || !pull) {
                        p.cancel("Cannot index without the embedding model");
                        return null;
                    }

                    const spinner = p.spinner();
                    spinner.start(`Pulling ${selectedModel}...`);
                    await ollama.ensureModel(selectedModel);
                    spinner.stop(`Model ${selectedModel} ready`);
                }
            } else {
                p.log.error("Ollama is not running. Start it with: ollama serve");
                return null;
            }
        } catch (err) {
            p.log.error(`Ollama check failed: ${err instanceof Error ? err.message : String(err)}`);
            return null;
        }
    }

    p.log.step(`${pc.bold("Path")}: ${absPath}`);
    p.log.step(`${pc.bold("Name")}: ${indexName}`);
    p.log.step(`${pc.bold("Type")}: ${indexType}`);
    p.log.step(`${pc.bold("Embeddings")}: ${enableEmbed ? `${selectedModel}` : "disabled"}`);

    const confirmed = await p.confirm({
        message: "Create this index?",
        initialValue: true,
    });

    if (p.isCancel(confirmed) || !confirmed) {
        p.cancel("Cancelled");
        return null;
    }

    return {
        name: indexName,
        baseDir: absPath,
        type: indexType,
        respectGitIgnore: indexType === "code",
        chunking: "auto",
        embedding: {
            enabled: enableEmbed,
            provider,
            model: selectedModel,
        },
    };
}

export function registerAddCommand(program: Command): void {
    program
        .command("add")
        .description("Add and index a directory")
        .argument("[path]", "Path to directory to index")
        .option("--name <name>", "Index name (default: directory basename)")
        .option("--type <type>", "Index type: code, files, mail, chat (default: auto-detect)")
        .option("--chunking <mode>", "Chunking strategy: ast, line, auto (default: auto)")
        .option("--model <id>", "Embedding model ID (see: tools indexer models)")
        .option("--no-embed", "Disable embeddings (fulltext-only search)")
        .option("--storage <driver>", "Storage driver: sqlite, orama, turbopuffer (default: sqlite)")
        .option("--watch", "Enable watch mode after indexing")
        .option("--ignore <patterns>", "Additional ignore patterns (comma-separated)", parseVariadic)
        .option("--include <suffixes>", "File suffixes to include (comma-separated)", parseVariadic)
        .action(async (path: string | undefined, opts: AddOptions) => {
            let config: IndexConfig;

            if (!path && process.stdout.isTTY) {
                const result = await runInteractiveFlow();

                if (!result) {
                    return;
                }

                config = result;
            } else if (!path) {
                p.log.error("Path is required in non-interactive mode");
                p.log.info("Usage: tools indexer add <path> --model <model-id>");
                p.log.info("Run 'tools indexer models' to see available models");
                process.exit(1);
            } else {
                const absPath = resolve(path);

                if (!existsSync(absPath)) {
                    p.log.error(`Path does not exist: ${absPath}`);
                    process.exit(1);
                }

                const name = opts.name ?? basename(absPath);
                const type = opts.type ?? autoDetectType(absPath);
                let model = opts.model;
                let provider = model ? resolveProvider(model) : undefined;

                p.intro(pc.bgCyan(pc.white(" indexer add ")));
                p.log.info(`Path: ${pc.dim(absPath)}`);
                p.log.info(`Name: ${pc.bold(name)}`);
                p.log.info(`Type: ${type}`);

                // Interactive model selection when no --model flag and embeddings enabled
                if (opts.embed !== false && !model && process.stdout.isTTY) {
                    const recommended = getModelsForType(type);

                    if (recommended.length > 0) {
                        const selected = await p.select({
                            message: "Embedding model",
                            options: [
                                ...recommended.slice(0, 5).map((m) => ({
                                    value: m.id,
                                    label: `${m.name} (${m.dimensions}-dim, ${m.provider})`,
                                    hint: m.description,
                                })),
                                { value: "__none__", label: "No embeddings (fulltext-only)" },
                            ],
                        });

                        if (p.isCancel(selected)) {
                            p.cancel("Cancelled");
                            return;
                        }

                        if (selected === "__none__") {
                            opts.embed = false;
                        } else {
                            model = selected as string;
                            provider = resolveProvider(model);
                        }
                    }
                }

                if (model) {
                    const found = MODEL_REGISTRY.find((m) => m.id === model);
                    p.log.info(
                        `Model: ${pc.bold(found?.name ?? model)} (${found?.dimensions ?? "??"}-dim, ${found?.provider ?? "unknown"})`
                    );
                } else if (opts.embed !== false) {
                    p.log.info(`Embeddings: ${pc.dim("disabled (no model selected)")}`);
                }

                p.log.info(`Chunking: ${pc.bold(opts.chunking ?? "auto")}`);

                config = {
                    name,
                    baseDir: absPath,
                    type,
                    respectGitIgnore: type === "code",
                    chunking: opts.chunking ?? "auto",
                    ignoredPaths: opts.ignore,
                    includedSuffixes: opts.include,
                    embedding: {
                        enabled: opts.embed !== false,
                        provider,
                        model,
                    },
                };

                if (opts.storage) {
                    config.storage = { driver: opts.storage };
                }

                if (opts.watch) {
                    config.watch = { enabled: true };
                }
            }

            const spinner = p.spinner();
            spinner.start("Indexing...");

            try {
                const manager = await IndexerManager.load();
                const indexer = await manager.addIndex(config, createProgressCallbacks(spinner));
                const stats = indexer.stats;

                spinner.stop("Indexing complete");

                p.log.success(
                    `Indexed ${pc.bold(String(stats.totalFiles))} files, ` +
                        `${pc.bold(String(stats.totalChunks))} chunks`
                );

                if (config.watch?.enabled) {
                    p.log.info("Watch mode enabled. Press Ctrl+C to stop.");
                    indexer.startWatch();

                    process.on("SIGINT", () => {
                        indexer.stopWatch();
                        manager.close().finally(() => process.exit(0));
                    });

                    await new Promise(() => {});
                } else {
                    await manager.close();
                    p.outro("Done");
                }
            } catch (err) {
                spinner.stop("Indexing failed");

                if (err instanceof EmbeddingSetupError) {
                    p.log.warn(err.message);
                    process.exit(1);
                }

                p.log.error(err instanceof Error ? err.message : String(err));
                process.exit(1);
            }
        });
}
