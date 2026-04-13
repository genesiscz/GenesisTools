#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { audioProcessor } from "@app/ask/audio/AudioProcessor.ts";
import { AI } from "@app/utils/ai/index.ts";
import { formatOutput, formatTimestamp, type OutputFormat, toSRT, toVTT } from "@app/utils/ai/transcription-format.ts";
import type { AIProviderType } from "@app/utils/ai/types.ts";
import { copyToClipboard } from "@app/utils/clipboard.ts";
import { formatBytes, formatDuration } from "@app/utils/format.ts";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

const SUPPORTED_AUDIO_EXTENSIONS = new Set([
    ".mp3",
    ".wav",
    ".m4a",
    ".aac",
    ".ogg",
    ".flac",
    ".wma",
    ".aiff",
    ".webm",
    ".opus",
    ".qta",
    ".mov",
    ".mp4",
]);

// Re-export for backwards compat (tests import from here)
export { formatOutput, formatTimestamp, toSRT, toVTT, type OutputFormat };

// ============================================
// Core transcription logic
// ============================================

interface TranscribeFlags {
    provider?: string;
    local?: boolean;
    format?: OutputFormat;
    lang?: string;
    model?: string;
    output?: string;
    clipboard?: boolean;
}

async function runTranscription(filePath: string, opts: TranscribeFlags): Promise<void> {
    const resolved = resolve(filePath);

    if (!existsSync(resolved)) {
        console.error(pc.red(`File not found: ${resolved}`));
        process.exit(1);
    }

    const ext = extname(resolved).toLowerCase();

    if (!SUPPORTED_AUDIO_EXTENSIONS.has(ext)) {
        console.error(pc.red(`Unsupported audio format: ${ext}`));
        console.error(pc.dim(`Supported: ${Array.from(SUPPORTED_AUDIO_EXTENSIONS).join(", ")}`));
        process.exit(1);
    }

    // Validate audio file
    const validation = await audioProcessor.validateAudioFile(resolved);

    if (!validation.isValid) {
        console.error(pc.red(`Invalid audio file: ${validation.error}`));
        process.exit(1);
    }

    // Show file info
    const fileInfo: string[] = [basename(resolved)];

    if (validation.format) {
        fileInfo.push(validation.format);
    }

    if (validation.duration) {
        fileInfo.push(formatDuration(validation.duration, "s", "hms"));
    }

    if (validation.size) {
        fileInfo.push(formatBytes(validation.size));
    }

    console.error(pc.dim(`File: ${fileInfo.join(" | ")}`));

    // Resolve provider
    const provider: AIProviderType | undefined = opts.local
        ? "local-hf"
        : (opts.provider as AIProviderType | undefined);
    const format = opts.format ?? "text";

    const s = p.spinner();
    s.start("Transcribing...");

    try {
        const transcriber = await AI.Transcriber.create({
            provider,
            model: opts.model,
            persist: true,
        });

        try {
            const result = await transcriber.transcribe(resolved, {
                language: opts.lang,
                format,
                model: opts.model,
                onProgress: (info) => {
                    s.message(info.message);
                },
                onSegment: (seg) => {
                    const ts = formatDuration(seg.start * 1000, "ms", "tiered");
                    s.message(`[${ts}] ${seg.text.trim()}`);
                },
            });

            s.stop(pc.green("Transcription complete"));

            // Show metadata
            if (result.language) {
                console.error(pc.dim(`Language: ${result.language}`));
            }

            if (result.duration) {
                console.error(pc.dim(`Duration: ${formatDuration(result.duration, "s", "hms")}`));
            }

            const output = formatOutput(result, format);

            // Output handling
            if (opts.clipboard) {
                await copyToClipboard(output, { label: "transcription" });
            }

            if (opts.output) {
                const outputPath = resolve(opts.output);
                await Bun.write(outputPath, output);
                console.error(pc.green(`Written to ${outputPath}`));
            }

            if (!opts.output && !opts.clipboard) {
                console.log(output);
            }
        } finally {
            transcriber.dispose();
        }
    } catch (error) {
        s.stop(pc.red("Transcription failed"));
        console.error(pc.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
    }
}

// ============================================
// Interactive mode
// ============================================

async function interactiveMode(): Promise<void> {
    p.intro(pc.bgCyan(pc.black(" tools transcribe ")));

    const filePath = await p.text({
        message: "Audio file path:",
        placeholder: "/path/to/audio.mp3",
        validate(value) {
            if (!value) {
                return "File path is required";
            }

            const resolved = resolve(value);

            if (!existsSync(resolved)) {
                return `File not found: ${resolved}`;
            }

            const ext = extname(resolved).toLowerCase();

            if (!SUPPORTED_AUDIO_EXTENSIONS.has(ext)) {
                return `Unsupported format: ${ext}`;
            }
        },
    });

    if (p.isCancel(filePath)) {
        p.cancel("Cancelled");
        return;
    }

    const providerChoice = await p.select({
        message: "Provider:",
        options: [
            { value: undefined, label: "Default", hint: "use configured provider" },
            { value: "local-hf", label: "Local (Hugging Face)", hint: "runs locally via transformers.js" },
            { value: "cloud", label: "Cloud (auto-select)", hint: "picks best available" },
            ...(process.env.OPENAI_API_KEY ? [{ value: "openai", label: "OpenAI", hint: "whisper-1" }] : []),
            ...(process.env.GROQ_API_KEY ? [{ value: "groq", label: "Groq", hint: "whisper-large-v3" }] : []),
            ...(process.env.OPENROUTER_API_KEY ? [{ value: "openrouter", label: "OpenRouter" }] : []),
            { value: "darwinkit", label: "DarwinKit", hint: "macOS native speech recognition" },
        ],
    });

    if (p.isCancel(providerChoice)) {
        p.cancel("Cancelled");
        return;
    }

    const format = await p.select<OutputFormat>({
        message: "Output format:",
        options: [
            { value: "text" as const, label: "Plain text" },
            { value: "json" as const, label: "JSON", hint: "full result with segments" },
            { value: "srt" as const, label: "SRT", hint: "SubRip subtitle format" },
            { value: "vtt" as const, label: "VTT", hint: "WebVTT subtitle format" },
        ],
    });

    if (p.isCancel(format)) {
        p.cancel("Cancelled");
        return;
    }

    const destination = await p.select<string>({
        message: "Output to:",
        options: [
            { value: "stdout", label: "Terminal (stdout)" },
            { value: "clipboard", label: "Clipboard" },
            { value: "file", label: "File" },
        ],
    });

    if (p.isCancel(destination)) {
        p.cancel("Cancelled");
        return;
    }

    let outputFile: string | undefined;

    if (destination === "file") {
        const extMap: Record<OutputFormat, string> = { text: ".txt", json: ".json", srt: ".srt", vtt: ".vtt" };
        const defaultOutput = resolve(filePath).replace(extname(filePath), extMap[format]);

        const out = await p.text({
            message: "Output file path:",
            placeholder: defaultOutput,
            defaultValue: defaultOutput,
        });

        if (p.isCancel(out)) {
            p.cancel("Cancelled");
            return;
        }

        outputFile = out;
    }

    await runTranscription(filePath, {
        provider: providerChoice as AIProviderType | undefined,
        format,
        output: outputFile,
        clipboard: destination === "clipboard",
    });

    p.outro(pc.green("Done"));
}

// ============================================
// CLI
// ============================================

const program = new Command()
    .name("transcribe")
    .description("Transcribe audio files using AI (local or cloud)")
    .argument("[file]", "Audio file to transcribe")
    .option("--provider <provider>", "AI provider (local-hf, cloud, openai, groq, openrouter, darwinkit)")
    .option("--local", "Shorthand for --provider local-hf")
    .option("--format <format>", "Output format (text, json, srt, vtt)", "text")
    .option("--lang <language>", "Audio language (e.g. en, cs, de)")
    .option("--model <model>", "Model name/id to use")
    .option("-o, --output <path>", "Write output to file")
    .option("-c, --clipboard", "Copy output to clipboard")
    .action(async (file: string | undefined, opts: TranscribeFlags) => {
        if (!file) {
            await interactiveMode();
            return;
        }

        await runTranscription(file, opts);
    });

async function main(): Promise<void> {
    try {
        await program.parseAsync(process.argv);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(message);
        process.exit(1);
    }
}

main();
