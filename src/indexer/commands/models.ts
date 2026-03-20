import { ModelManager } from "@app/utils/ai/ModelManager";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { formatModelTable, getModelsForType, MODEL_REGISTRY } from "../lib/model-registry";

export function registerModelsCommand(program: Command): void {
    const cmd = program
        .command("models")
        .description("List available embedding models")
        .option("--type <type>", "Filter by index type: code, files, mail, chat")
        .action(async (opts: { type?: string }) => {
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
            console.log(formatModelTable(models));
            console.log("");

            const downloaded = models.filter((m) => m.provider === "local-hf" && mm.isDownloaded(m.id));

            if (downloaded.length > 0) {
                p.log.success(`Downloaded: ${downloaded.map((m) => m.name).join(", ")}`);
            }

            const cloudModels = models.filter((m) => m.provider === "cloud");

            if (cloudModels.length > 0) {
                p.log.info(`Cloud models require API keys (no download needed)`);
            }

            const darwinModels = models.filter((m) => m.provider === "darwinkit");

            if (darwinModels.length > 0 && process.platform === "darwin") {
                p.log.info(`DarwinKit models use macOS built-in NaturalLanguage framework`);
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
            spin.start(`Downloading ${model.name} (~${model.ramGB}GB)...`);

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
