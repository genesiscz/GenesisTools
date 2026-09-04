#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { registerAiProxyRefScanner } from "@app/ai-proxy/lib/account-refs";
import { loadConfigFresh } from "@app/ai-proxy/lib/config";
import * as p from "@clack/prompts";
import { AI, AIConfig } from "@genesiscz/utils/ai/index.ts";
import { ModelManager } from "@genesiscz/utils/ai/ModelManager.ts";
import { runTool } from "@genesiscz/utils/cli";
import { copyToClipboard, readFromClipboard } from "@genesiscz/utils/clipboard.ts";
import { env } from "@genesiscz/utils/env";
import { formatBytes } from "@genesiscz/utils/format.ts";
import { logger, out } from "@genesiscz/utils/logger";
import { classifyText } from "@genesiscz/utils/macos/classification.ts";
import { detectLanguage } from "@genesiscz/utils/macos/nlp.ts";
import { ensurePackage } from "@genesiscz/utils/packages.ts";
import { withCancel } from "@genesiscz/utils/prompts/clack/helpers.ts";
import { formatTable } from "@genesiscz/utils/table.ts";
import { Command } from "commander";
import pc from "picocolors";
import { registerAccountsCommands } from "./commands/accounts";
import { registerConfigCommands } from "./commands/config";
import { readStdinValue } from "./commands/config/stdin";
import { runConfigTui } from "./commands/config/tui";
import { registerSessionsCommands } from "./commands/sessions";
import { registerUsageDaemonCommands } from "./commands/usage/daemon";

// Without this, `referrersOf` in this process cannot see the accounts the
// ai-proxy config bills, so `account rm` would delete an account (and its vault
// secrets) the running proxy still routes to, and `link ls`/`doctor` would
// miss dangling proxy refs. The scanner registry is per process; ai-proxy's own
// entrypoint registers the same scanner for itself.
registerAiProxyRefScanner(loadConfigFresh);

// ============================================
// Translate
// ============================================

interface TranslateFlags {
    to?: string;
    from?: string;
    provider?: string;
    clipboard?: boolean;
}

/**
 * Prose input, so full trimming is wanted here — unlike `config secret set`,
 * whose `readStdinValue` preserves bytes verbatim for PEM blobs. One stream
 * reader underneath, two contracts on top.
 */
async function readStdin(): Promise<string | null> {
    const value = await readStdinValue();

    return value?.trim() || null;
}

async function cmdTranslate(text: string | undefined, opts: TranslateFlags): Promise<void> {
    let input = text;

    if (!input) {
        input = (await readStdin()) ?? undefined;
    }

    if (!input) {
        out.error(pc.red("No text provided. Pass text as argument or pipe via stdin."));
        process.exit(1);
    }

    if (!opts.to) {
        out.error(pc.red("--to <lang> is required (e.g. --to en)"));
        process.exit(1);
    }

    let fromLang = opts.from;

    if (!fromLang && process.platform === "darwin") {
        try {
            const detected = await detectLanguage(input);
            fromLang = detected.language;
            out.error(pc.dim(`Detected language: ${fromLang}`));
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
            out.error(pc.dim(`${result.from} → ${result.to}`));

            if (opts.clipboard) {
                await copyToClipboard(result.text, { label: "translation" });
            }

            out.println(result.text);
        } finally {
            translator.dispose();
        }
    } catch (error) {
        s.stop(pc.red("Translation failed"));
        out.error(pc.red(error instanceof Error ? error.message : String(error)));
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
            out.error(pc.red(`File not found: ${resolved}`));
            process.exit(1);
        }

        input = await Bun.file(resolved).text();
    } else {
        // No file, no stdin — try clipboard
        try {
            input = await readFromClipboard();
            out.error(pc.dim("Reading from clipboard..."));
        } catch {
            // ignore
        }
    }

    if (!input?.trim()) {
        out.error(pc.red("No text to summarize. Provide a file, pipe stdin, or have text in clipboard."));
        process.exit(1);
    }

    const maxLength = opts.maxLength ? Number.parseInt(opts.maxLength, 10) : undefined;

    const s = p.spinner();
    s.start("Summarizing...");

    try {
        const result = await AI.summarize(input, { maxLength });

        s.stop(pc.green("Summarization complete"));
        out.error(pc.dim(`Original: ${formatBytes(input.length)} → Summary: ${formatBytes(result.summary.length)}`));

        if (opts.clipboard) {
            await copyToClipboard(result.summary, { label: "summary" });
        }

        out.println(result.summary);
    } catch (error) {
        s.stop(pc.red("Summarization failed"));
        out.error(pc.red(error instanceof Error ? error.message : String(error)));
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
    const token = config.getHfToken() ?? env.hf.getKey();

    if (!token) {
        out.error(pc.red("Hugging Face token required."));
        out.error(pc.dim("Set HUGGINGFACE_TOKEN env var or run: tools ai config"));
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
        out.error(pc.dim(`Model: ${model}`));
        out.error(pc.dim(`Size: ${formatBytes(arrayBuffer.byteLength)}`));
        out.println(outputPath);
    } catch (error) {
        s.stop(pc.red("Image generation failed"));
        out.error(pc.red(error instanceof Error ? error.message : String(error)));
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
        out.error(pc.red("No text provided. Pass text as argument or pipe via stdin."));
        process.exit(1);
    }

    if (!opts.categories) {
        out.error(pc.red('--categories is required (e.g. --categories "positive,negative,neutral")'));
        process.exit(1);
    }

    const categories = opts.categories.split(",").map((c) => c.trim());

    if (categories.length < 2) {
        out.error(pc.red("At least 2 categories are required."));
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
        out.println(table);
    } catch (error) {
        s.stop(pc.red("Classification failed"));
        out.error(pc.red(error instanceof Error ? error.message : String(error)));
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
    out.println(table);
    out.error(pc.dim(`\nTotal: ${cacheInfo.modelCount} models, ${cacheInfo.formatted}`));
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
        out.error(pc.red(error instanceof Error ? error.message : String(error)));
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
        await runConfigTui();
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
            await unlink(tmpPath).catch((err) =>
                logger.debug({ err, path: tmpPath }, "[cleanup] best-effort resource cleanup failed")
            );
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

registerAccountsCommands(program);
registerConfigCommands(program);
registerSessionsCommands(program);

// `tools ai usage` grows the TUI and the filters in Plan-Usage phase 7; the daemon
// subcommands are mounted here now so `ai-usage-poll` has a home (spec section 6.5).
const usageCmd = program.command("usage").description("Usage limits for every AI provider");
registerUsageDaemonCommands(usageCmd);

async function main(): Promise<void> {
    try {
        await runTool(program, { tool: "ai" });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        // An aborted prompt is not a failure. `tools claude login` has always
        // exited 0 quietly on Ctrl-C, and the login flows now throw the same
        // `Cancelled` through this entrypoint, so `tools ai accounts login`
        // reported the abort as `error: Cancelled` with exit 1 (gap/cli).
        if (message.includes("ExitPromptError") || message === "Cancelled") {
            await out.flush();
            process.exit(0);
        }

        p.log.error(message);
        // Drain before exiting: `out.*` and clack both write fire-and-forget, so
        // exiting in the same tick can tear the pipe down with the diagnostic
        // still queued and leave the user an empty exit 1 (PR #360 review t12).
        await out.flush();
        process.exit(1);
    }
}

try {
    await main();
} catch (err) {
    out.error(err instanceof Error ? err.message : String(err));
    await out.flush();
    process.exit(1);
}
