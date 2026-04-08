import { ModelManager } from "@app/utils/ai/ModelManager";
import type { ModelEntry } from "@app/utils/ai/types";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { formatModelTable, getModelsForType, MODEL_REGISTRY } from "../lib/model-registry";

const PROVIDER_ORDER = ["ollama", "coreml", "darwinkit", "local-hf", "cloud", "google"];
const PROVIDER_DISPLAY: Record<string, string> = {
    ollama: "Ollama (GPU Metal)",
    coreml: "CoreML (Neural Engine)",
    darwinkit: "DarwinKit (macOS built-in)",
    "local-hf": "Local HuggingFace (ONNX)",
    cloud: "Cloud API",
    google: "Google API",
};

function printGroupedByProvider(models: ReadonlyArray<ModelEntry>, mm: ModelManager): void {
    const grouped = new Map<string, ModelEntry[]>();

    for (const m of models) {
        const list = grouped.get(m.provider) ?? [];
        list.push(m);
        grouped.set(m.provider, list);
    }

    const sortedProviders = [...grouped.keys()].sort(
        (a, b) => (PROVIDER_ORDER.indexOf(a) ?? 99) - (PROVIDER_ORDER.indexOf(b) ?? 99)
    );

    for (const provider of sortedProviders) {
        const group = grouped.get(provider)!;
        const label = PROVIDER_DISPLAY[provider] ?? provider;
        console.log(`  ${pc.bold(label)}`);

        for (const m of group) {
            const dims = m.dimensions ? `${m.dimensions}-dim` : "";
            const ctx = m.contextLength ? `${m.contextLength} ctx` : "";
            const meta = [dims, ctx, m.speed].filter(Boolean).join(", ");
            const downloaded = m.provider === "local-hf" && mm.isDownloaded(m.id);
            const status = downloaded ? pc.green(" ✓") : m.provider === "local-hf" ? pc.dim(" (not downloaded)") : "";

            console.log(`    ${m.name}${status}`);
            console.log(`      ${pc.dim(m.id)}  ${pc.dim(meta)}`);

            if (m.installCmd) {
                console.log(`      ${pc.dim("$")} ${pc.cyan(m.installCmd)}`);
            }
        }

        console.log("");
    }
}

export function registerModelsCommand(program: Command): void {
    const cmd = program
        .command("models")
        .description("List available embedding models")
        .option("--type <type>", "Filter by index type: code, files, mail, chat")
        .option("--flat", "Show as flat table instead of grouped by provider")
        .action(async (opts: { type?: string; flat?: boolean }) => {
            const type = opts.type as "code" | "files" | "mail" | "chat" | undefined;

            if (type && !["code", "files", "mail", "chat"].includes(type)) {
                p.log.error(`Invalid type: ${type}. Must be one of: code, files, mail, chat`);
                process.exit(1);
            }

            const models = type ? getModelsForType(type) : MODEL_REGISTRY;
            const mm = new ModelManager();

            console.log("");

            if (type) {
                p.log.info(`Models for ${pc.bold(type)} indexes (best matches first):`);
            } else {
                p.log.info("All available embedding models:");
            }

            console.log("");

            if (opts.flat) {
                console.log(formatModelTable(models));
            } else {
                printGroupedByProvider(models, mm);
            }

            console.log("");
        });

    cmd.command("download")
        .description("Pre-download a local HuggingFace model")
        .argument("<model-id>", "Model ID from the registry")
        .action(async (modelId: string) => {
            const model = MODEL_REGISTRY.find((m) => m.id === modelId);

            if (!model) {
                p.log.error(`Unknown model: ${modelId}`);
                p.log.info("Available model IDs:");

                for (const m of MODEL_REGISTRY) {
                    console.log(`  ${m.id}`);
                }

                process.exit(1);
            }

            if (model.provider !== "local-hf") {
                p.log.error(`Model "${model.name}" is a ${model.provider} model and cannot be downloaded`);
                process.exit(1);
            }

            const mm = new ModelManager();

            if (mm.isDownloaded(modelId)) {
                p.log.success(`${model.name} is already downloaded`);
                return;
            }

            const spin = p.spinner();
            spin.start(`Downloading ${model.name}...`);

            try {
                await mm.download(modelId);
                spin.stop(`${model.name} downloaded successfully`);
            } catch (err) {
                spin.stop(`Download failed`);
                p.log.error(err instanceof Error ? err.message : String(err));
                process.exit(1);
            }
        });
}
