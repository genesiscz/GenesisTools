#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AI, AIConfig } from "@app/utils/ai/index.ts";
import { ModelManager } from "@app/utils/ai/ModelManager.ts";
import type { AIProviderType, AITask } from "@app/utils/ai/types.ts";
import { copyToClipboard, readFromClipboard } from "@app/utils/clipboard.ts";
import { formatBytes } from "@app/utils/format.ts";
import { ensurePackage } from "@app/utils/packages.ts";
import { classifyText } from "@app/utils/macos/classification.ts";
import { detectLanguage } from "@app/utils/macos/nlp.ts";
import { withCancel } from "@app/utils/prompts/clack/helpers.ts";
import { formatTable } from "@app/utils/table.ts";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

// ============================================
// Translate
// ============================================

interface TranslateFlags {
    to?: string;
    from?: string;
    provider?: string;
    clipboard?: boolean;
}

async function readStdin(): Promise<string | null> {
    if (process.stdin.isTTY) {
        return null;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
    }

    const text = Buffer.concat(chunks).toString("utf-8").trim();

    if (!text) {
        return null;
    }

    return text;
}

async function cmdTranslate(text: string | undefined, opts: TranslateFlags): Promise<void> {
    let input = text;

    if (!input) {
        input = (await readStdin()) ?? undefined;
    }

    if (!input) {
        console.error(pc.red("No text provided. Pass text as argument or pipe via stdin."));
        process.exit(1);
    }

    if (!opts.to) {
        console.error(pc.red("--to <lang> is required (e.g. --to en)"));
        process.exit(1);
    }

    let fromLang = opts.from;

    if (!fromLang && process.platform === "darwin") {
        try {
            const detected = await detectLanguage(input);
            fromLang = detected.language;
            console.error(pc.dim(`Detected language: ${fromLang}`));
        } catch {
            // fallback — let the provider auto-detect
        }
    }

    const s = p.spinner();
    s.start("Translating...");

    try {
        const translator = await AI.Translator.create({
            provider: opts.provider,
        });

        try {
            const result = await translator.translate(input, {
                from: fromLang,
                to: opts.to,
            });

            s.stop(pc.green("Translation complete"));
            console.error(pc.dim(`${result.from} → ${result.to}`));

            if (opts.clipboard) {
                await copyToClipboard(result.text, { label: "translation" });
            }

            console.log(result.text);
        } finally {
            translator.dispose();
        }
    } catch (error) {
        s.stop(pc.red("Translation failed"));
        console.error(pc.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
    }
}

// ============================================
// Summarize
// ============================================

interface SummarizeFlags {
    maxLength?: string;
    provider?: string;
    clipboard?: boolean;
}

async function cmdSummarize(file: string | undefined, opts: SummarizeFlags): Promise<void> {
    let input: string | undefined;

    if (file === "-" || (!file && !process.stdin.isTTY)) {
        input = (await readStdin()) ?? undefined;
    } else if (file) {
        const resolved = resolve(file);

        if (!existsSync(resolved)) {
            console.error(pc.red(`File not found: ${resolved}`));
            process.exit(1);
        }

        input = await Bun.file(resolved).text();
    } else {
        // No file, no stdin — try clipboard
        try {
            input = await readFromClipboard();
            console.error(pc.dim("Reading from clipboard..."));
        } catch {
            // ignore
        }
    }

    if (!input?.trim()) {
        console.error(pc.red("No text to summarize. Provide a file, pipe stdin, or have text in clipboard."));
        process.exit(1);
    }

    const maxLength = opts.maxLength ? Number.parseInt(opts.maxLength, 10) : undefined;

    const s = p.spinner();
    s.start("Summarizing...");

    try {
        const result = await AI.summarize(input, { maxLength });

        s.stop(pc.green("Summarization complete"));
        console.error(
            pc.dim(`Original: ${formatBytes(input.length)} → Summary: ${formatBytes(result.summary.length)}`)
        );

        if (opts.clipboard) {
            await copyToClipboard(result.summary, { label: "summary" });
        }

        console.log(result.summary);
    } catch (error) {
        s.stop(pc.red("Summarization failed"));
        console.error(pc.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
    }
}

// ============================================
// Image generation
// ============================================

interface ImageFlags {
    output: string;
    model?: string;
}

async function cmdImage(prompt: string, opts: ImageFlags): Promise<void> {
    const config = await AIConfig.load();
    const token = config.getHfToken() ?? process.env.HUGGINGFACE_TOKEN;

    if (!token) {
        console.error(pc.red("Hugging Face token required."));
        console.error(pc.dim("Set HUGGINGFACE_TOKEN env var or run: tools ai config"));
        process.exit(1);
    }

    const model = opts.model ?? "stabilityai/stable-diffusion-xl-base-1.0";
    const outputPath = resolve(opts.output);

    const s = p.spinner();
    s.start(`Generating image with ${pc.bold(model)}...`);

    try {
        await ensurePackage("@huggingface/inference", {
            label: "HuggingFace Inference (image generation)",
        });
        const { InferenceClient } = await import("@huggingface/inference");
        const client = new InferenceClient(token);

        const result = await client.textToImage({
            model,
            inputs: prompt,
        });

        let arrayBuffer: ArrayBuffer;

        if (typeof result === "string") {
            const response = await fetch(result);
            arrayBuffer = await response.arrayBuffer();
        } else {
            arrayBuffer = await (result as Blob).arrayBuffer();
        }

        await Bun.write(outputPath, arrayBuffer);

        s.stop(pc.green("Image generated"));
        console.error(pc.dim(`Model: ${model}`));
        console.error(pc.dim(`Size: ${formatBytes(arrayBuffer.byteLength)}`));
        console.log(outputPath);
    } catch (error) {
        s.stop(pc.red("Image generation failed"));
        console.error(pc.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
    }
}

// ============================================
// Classify
// ============================================

interface ClassifyFlags {
    categories?: string;
    provider?: string;
}

async function cmdClassify(text: string | undefined, opts: ClassifyFlags): Promise<void> {
    let input = text;

    if (!input) {
        input = (await readStdin()) ?? undefined;
    }

    if (!input) {
        console.error(pc.red("No text provided. Pass text as argument or pipe via stdin."));
        process.exit(1);
    }

    if (!opts.categories) {
        console.error(pc.red('--categories is required (e.g. --categories "positive,negative,neutral")'));
        process.exit(1);
    }

    const categories = opts.categories.split(",").map((c) => c.trim());

    if (categories.length < 2) {
        console.error(pc.red("At least 2 categories are required."));
        process.exit(1);
    }

    const s = p.spinner();
    s.start("Classifying...");

    try {
        const result = await classifyText(input, categories);

        s.stop(pc.green("Classification complete"));

        const rows = result.scores.map((s) => [
            s.category === result.category ? pc.bold(s.category) : s.category,
            `${(s.score * 100).toFixed(1)}%`,
        ]);

        const table = formatTable(rows, ["Category", "Confidence"], { alignRight: [1] });
        console.log(table);
    } catch (error) {
        s.stop(pc.red("Classification failed"));
        console.error(pc.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
    }
}

// ============================================
// Models
// ============================================

async function cmdModelsList(): Promise<void> {
    const manager = new ModelManager();
    const models = await manager.listDownloaded();

    if (models.length === 0) {
        p.log.info("No downloaded models found.");
        return;
    }

    const rows = models.map((m) => [m.modelId, formatBytes(m.sizeBytes)]);
    const table = formatTable(rows, ["Model", "Size"], { alignRight: [1] });

    const cacheInfo = await manager.getCacheSize();
    console.log(table);
    console.error(pc.dim(`\nTotal: ${cacheInfo.modelCount} models, ${cacheInfo.formatted}`));
}

async function cmdModelsDownload(modelId: string, opts: { dtype?: string }): Promise<void> {
    const manager = new ModelManager();

    if (manager.isDownloaded(modelId)) {
        p.log.info(`Model ${pc.bold(modelId)} is already downloaded.`);
        return;
    }

    const s = p.spinner();
    s.start(`Downloading ${pc.bold(modelId)}...`);

    try {
        const dtype = (opts.dtype ?? "fp32") as "auto" | "fp16" | "fp32" | "q4" | "q8" | "int8" | "uint8";
        await manager.download(modelId, { dtype });
        s.stop(pc.green(`Downloaded ${modelId}`));
    } catch (error) {
        s.stop(pc.red("Download failed"));
        console.error(pc.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
    }
}

async function cmdModelsClean(opts: { older?: string }): Promise<void> {
    const manager = new ModelManager();
    const olderThanMs = opts.older ? Number.parseInt(opts.older, 10) * 24 * 60 * 60 * 1000 : undefined;

    const s = p.spinner();
    s.start("Cleaning model cache...");

    const count = await manager.cleanup(olderThanMs);
    s.stop(count > 0 ? pc.green(`Removed ${count} model(s)`) : pc.dim("No models to clean up"));
}

// ============================================
// Config
// ============================================

const TASK_LABELS: Record<AITask, string> = {
    transcribe: "Transcription",
    translate: "Translation",
    summarize: "Summarization",
    classify: "Classification",
    embed: "Embedding",
    sentiment: "Sentiment Analysis",
};

const PROVIDER_OPTIONS: Array<{ value: AIProviderType; label: string; hint: string }> = [
    { value: "local-hf", label: "Local (Hugging Face)", hint: "runs locally via transformers.js" },
    { value: "cloud", label: "Cloud", hint: "remote API (Groq, OpenAI, etc.)" },
    { value: "darwinkit", label: "DarwinKit", hint: "macOS native ML" },
];

async function cmdConfig(): Promise<void> {
    p.intro(pc.bgCyan(pc.black(" AI Configuration ")));

    const config = await AIConfig.load();

    // Show current config
    const tasks: AITask[] = ["transcribe", "translate", "summarize", "classify", "embed", "sentiment"];
    const currentRows = tasks.map((task) => {
        const taskConfig = config.get(task);
        return [TASK_LABELS[task], taskConfig.provider, taskConfig.model ?? pc.dim("default")];
    });
    const hfToken = config.getHfToken();
    p.note(formatTable(currentRows, ["Task", "Provider", "Model"]), "Current Configuration");

    if (hfToken) {
        p.log.info(`HF Token: ${pc.dim(`${hfToken.slice(0, 8)}...${hfToken.slice(-4)}`)}`);
    } else {
        p.log.info(`HF Token: ${pc.dim("not set")}`);
    }

    const action = await withCancel(
        p.select({
            message: "What would you like to configure?",
            options: [
                { value: "task", label: "Task provider/model" },
                { value: "hf-token", label: "Hugging Face token" },
                { value: "done", label: "Exit" },
            ],
        })
    );

    if (action === "done") {
        p.outro(pc.dim("No changes made."));
        return;
    }

    if (action === "hf-token") {
        const token = await withCancel(
            p.text({
                message: "Hugging Face API token:",
                placeholder: "hf_...",
                validate(value = "") {
                    if (!value.startsWith("hf_")) {
                        return 'Token should start with "hf_"';
                    }
                },
            })
        );

        config.setHfToken(token);
        await config.save();
        p.outro(pc.green("Token saved."));
        return;
    }

    // Configure task
    const taskChoice = await withCancel(
        p.select({
            message: "Select task to configure:",
            options: tasks.map((t) => ({
                value: t,
                label: `${TASK_LABELS[t]} ${pc.dim(`(${config.getProvider(t)})`)}`,
            })),
        })
    );

    const provider = await withCancel(
        p.select({
            message: "Provider:",
            options: PROVIDER_OPTIONS,
            initialValue: config.getProvider(taskChoice),
        })
    );

    const model = await withCancel(
        p.text({
            message: "Model (leave empty for default):",
            placeholder: "default",
            defaultValue: "",
        })
    );

    config.set(taskChoice, {
        provider,
        model: model || undefined,
    });
    await config.save();

    p.outro(pc.green(`${TASK_LABELS[taskChoice]} updated: ${provider}${model ? ` (${model})` : ""}`));
}

// ============================================
// Interactive mode
// ============================================

async function interactiveMode(): Promise<void> {
    p.intro(pc.bgCyan(pc.black(" tools ai ")));

    const action = await withCancel(
        p.select({
            message: "What do you want to do?",
            options: [
                { value: "translate", label: "Translate text" },
                { value: "summarize", label: "Summarize text" },
                { value: "image", label: "Generate image", hint: "requires HF token" },
                { value: "classify", label: "Classify text" },
                { value: "models", label: "Manage models" },
                { value: "config", label: "Configure AI settings" },
            ],
        })
    );

    if (action === "config") {
        await cmdConfig();
        return;
    }

    if (action === "models") {
        await cmdModelsList();
        p.outro(pc.dim("Done."));
        return;
    }

    if (action === "translate") {
        const text = await withCancel(p.text({ message: "Text to translate:", placeholder: "Enter text..." }));

        const to = await withCancel(p.text({ message: "Target language:", placeholder: "en" }));

        await cmdTranslate(text, { to });
        p.outro(pc.green("Done."));
        return;
    }

    if (action === "summarize") {
        const source = await withCancel(
            p.select({
                message: "Read from:",
                options: [
                    { value: "input", label: "Type/paste text" },
                    { value: "clipboard", label: "Clipboard" },
                    { value: "file", label: "File" },
                ],
            })
        );

        if (source === "clipboard") {
            await cmdSummarize(undefined, {});
            p.outro(pc.green("Done."));
            return;
        }

        if (source === "file") {
            const filePath = await withCancel(
                p.text({
                    message: "File path:",
                    validate(value) {
                        if (!value) {
                            return "File path required";
                        }

                        if (!existsSync(resolve(value))) {
                            return `File not found: ${value}`;
                        }
                    },
                })
            );

            await cmdSummarize(filePath, {});
            p.outro(pc.green("Done."));
            return;
        }

        const text = await withCancel(p.text({ message: "Text to summarize:", placeholder: "Paste text..." }));

        // Write to temp file for the summarizer, clean up after
        const tmpPath = join(tmpdir(), `ai-summarize-${Date.now()}.txt`);
        await Bun.write(tmpPath, text);

        try {
            await cmdSummarize(tmpPath, {});
        } finally {
            await unlink(tmpPath).catch(() => {});
        }
        p.outro(pc.green("Done."));
        return;
    }

    if (action === "image") {
        const prompt = await withCancel(
            p.text({ message: "Image prompt:", placeholder: "A futuristic cityscape at sunset..." })
        );

        const output = await withCancel(
            p.text({
                message: "Output file path:",
                placeholder: "./image.png",
                defaultValue: `./ai-image-${Date.now()}.png`,
            })
        );

        await cmdImage(prompt, { output });
        p.outro(pc.green("Done."));
        return;
    }

    if (action === "classify") {
        const text = await withCancel(p.text({ message: "Text to classify:", placeholder: "Enter text..." }));

        const categories = await withCancel(
            p.text({
                message: "Categories (comma-separated):",
                placeholder: "positive, negative, neutral",
                validate(value = "") {
                    const cats = value
                        .split(",")
                        .map((c) => c.trim())
                        .filter(Boolean);

                    if (cats.length < 2) {
                        return "At least 2 categories required";
                    }
                },
            })
        );

        await cmdClassify(text, { categories });
        p.outro(pc.green("Done."));
        return;
    }
}

// ============================================
// CLI
// ============================================

const program = new Command();

program
    .name("ai")
    .description("Unified AI toolkit — translate, summarize, classify, generate images, manage models")
    .action(async () => {
        await interactiveMode();
    });

program
    .command("translate")
    .description("Translate text between languages")
    .argument("[text]", "Text to translate (or pipe via stdin)")
    .option("--to <lang>", "Target language (required)")
    .option("--from <lang>", "Source language (auto-detect if omitted)")
    .option("--provider <provider>", "AI provider (local-hf, cloud, darwinkit)")
    .option("-c, --clipboard", "Copy result to clipboard")
    .action(async (text: string | undefined, opts: TranslateFlags) => {
        await cmdTranslate(text, opts);
    });

program
    .command("summarize")
    .description("Summarize text from file, stdin, or clipboard")
    .argument("[file]", 'File to summarize (use "-" for stdin, omit for clipboard)')
    .option("--max-length <n>", "Maximum summary length")
    .option("--provider <provider>", "AI provider")
    .option("-c, --clipboard", "Copy result to clipboard")
    .action(async (file: string | undefined, opts: SummarizeFlags) => {
        await cmdSummarize(file, opts);
    });

program
    .command("image")
    .description("Generate an image from a text prompt (requires HUGGINGFACE_TOKEN)")
    .argument("<prompt>", "Image generation prompt")
    .requiredOption("-o, --output <path>", "Output file path")
    .option("--model <model>", "HF model ID", "stabilityai/stable-diffusion-xl-base-1.0")
    .action(async (prompt: string, opts: ImageFlags) => {
        await cmdImage(prompt, opts);
    });

program
    .command("classify")
    .description("Classify text into categories using semantic similarity")
    .argument("[text]", "Text to classify (or pipe via stdin)")
    .requiredOption("--categories <list>", 'Comma-separated categories (e.g. "positive,negative,neutral")')
    .option("--provider <provider>", "AI provider")
    .action(async (text: string | undefined, opts: ClassifyFlags) => {
        await cmdClassify(text, opts);
    });

const modelsCmd = program.command("models").description("Manage downloaded AI models");

modelsCmd
    .command("list")
    .description("List downloaded models with sizes")
    .action(async () => {
        await cmdModelsList();
    });

modelsCmd
    .command("download")
    .description("Download a model for local use")
    .argument("<model-id>", "Model ID (e.g. whisper-small, Xenova/opus-mt-cs-en)")
    .option("--dtype <dtype>", "Data type (auto, fp16, fp32, q4, q8, int8, uint8)", "fp32")
    .action(async (modelId: string, opts: { dtype?: string }) => {
        await cmdModelsDownload(modelId, opts);
    });

modelsCmd
    .command("clean")
    .description("Remove cached models")
    .option("--older <days>", "Only remove models older than N days")
    .action(async (opts: { older?: string }) => {
        await cmdModelsClean(opts);
    });

program
    .command("config")
    .description("Configure AI providers, models, and tokens")
    .action(async () => {
        await cmdConfig();
    });

async function main(): Promise<void> {
    try {
        await program.parseAsync(process.argv);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        p.log.error(message);
        process.exit(1);
    }
}

main();
