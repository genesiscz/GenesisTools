#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { audioProcessor } from "@app/ask/audio/AudioProcessor.ts";
import { out } from "@app/logger";
import { AI } from "@app/utils/ai/index.ts";
import { getAllProviders } from "@app/utils/ai/providers/index.ts";
import { formatOutput, formatTimestamp, type OutputFormat, toSRT, toVTT } from "@app/utils/ai/transcription-format.ts";
import type { AIProviderType } from "@app/utils/ai/types.ts";
import { runTool } from "@app/utils/cli";
import { isInteractive, suggestCommand } from "@app/utils/cli/executor.ts";
import { isQuietOutput } from "@app/utils/cli/output-mode.ts";
import { createQuietSpinner } from "@app/utils/cli/quiet-spinner.ts";
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
export { formatOutput, formatTimestamp, type OutputFormat, toSRT, toVTT };

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
    clean?: boolean;
    raw?: boolean;
    diarize?: boolean;
    speakers?: number;
}

async function runTranscription(filePath: string, opts: TranscribeFlags): Promise<void> {
    const resolved = resolve(filePath);

    if (!existsSync(resolved)) {
        out.error(pc.red(`File not found: ${resolved}`));
        process.exit(1);
    }

    const ext = extname(resolved).toLowerCase();

    if (!SUPPORTED_AUDIO_EXTENSIONS.has(ext)) {
        out.error(pc.red(`Unsupported audio format: ${ext}`));
        out.error(pc.dim(`Supported: ${Array.from(SUPPORTED_AUDIO_EXTENSIONS).join(", ")}`));
        process.exit(1);
    }

    // Validate audio file
    const validation = await audioProcessor.validateAudioFile(resolved);

    if (!validation.isValid) {
        out.error(pc.red(`Invalid audio file: ${validation.error}`));
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

    out.error(pc.dim(`File: ${fileInfo.join(" | ")}`));

    // Resolve provider
    const provider: AIProviderType | undefined = opts.local
        ? "local-hf"
        : (opts.provider as AIProviderType | undefined);
    const format = opts.format ?? "text";

    // In a non-TTY / structured-output context the clack spinner floods the
    // pipe with animation frames. Use a no-op spinner and route only milestone
    // status to stderr (never stdout — that carries the transcript).
    const quiet = isQuietOutput(format);
    const s = quiet ? createQuietSpinner() : p.spinner();
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
                clean: opts.raw ? false : opts.clean,
                diarize: opts.diarize,
                speakers: opts.speakers,
                onProgress: (info) => {
                    if (quiet) {
                        // Drop per-chunk churn; keep coarse phase milestones.
                        if (!info.message.startsWith("Transcribing chunk")) {
                            process.stderr.write(`${pc.dim(info.message)}\n`);
                        }

                        return;
                    }

                    s.message(info.message);
                },
                onSegment: (seg) => {
                    if (quiet) {
                        return;
                    }

                    const ts = formatDuration(seg.start * 1000, "ms", "tiered");
                    s.message(`[${ts}] ${seg.text.trim()}`);
                },
            });

            if (quiet) {
                process.stderr.write(`${pc.green("Transcription complete")}\n`);
            } else {
                s.stop(pc.green("Transcription complete"));
            }

            // Show metadata
            if (result.language) {
                out.error(pc.dim(`Language: ${result.language}`));
            }

            if (result.duration) {
                out.error(pc.dim(`Duration: ${formatDuration(result.duration, "s", "hms")}`));
            }

            const output = formatOutput(result, format);

            // Output handling
            if (opts.clipboard) {
                await copyToClipboard(output, { label: "transcription" });
            }

            if (opts.output) {
                const outputPath = resolve(opts.output);
                await Bun.write(outputPath, output);
                out.error(pc.green(`Written to ${outputPath}`));
            }

            if (!opts.output && !opts.clipboard) {
                out.println(output);
            }
        } finally {
            transcriber.dispose();
        }
    } catch (error) {
        if (quiet) {
            process.stderr.write(`${pc.red("Transcription failed")}\n`);
        } else {
            s.stop(pc.red("Transcription failed"));
        }

        out.error(pc.red(error instanceof Error ? error.message : String(error)));
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
            { value: "local-hf", label: "Local (Hugging Face)", hint: "runs locally via transformers.js" },
            { value: "cloud", label: "Cloud (auto-select)", hint: "picks best available" },
            ...(process.env.OPENAI_API_KEY ? [{ value: "openai", label: "OpenAI", hint: "whisper-1" }] : []),
            ...(process.env.GROQ_API_KEY ? [{ value: "groq", label: "Groq", hint: "whisper-large-v3" }] : []),
            ...(process.env.OPENROUTER_API_KEY ? [{ value: "openrouter", label: "OpenRouter" }] : []),
            ...(process.env.X_AI_API_KEY ? [{ value: "xai", label: "xAI (Grok)", hint: "grok-voice STT" }] : []),
            { value: "darwinkit", label: "DarwinKit", hint: "macOS native speech recognition" },
        ],
    });

    if (p.isCancel(providerChoice)) {
        p.cancel("Cancelled");
        return;
    }

    const diarize = await p.confirm({
        message: "Identify speakers (diarization)?",
        initialValue: false,
    });

    if (p.isCancel(diarize)) {
        p.cancel("Cancelled");
        return;
    }

    let speakers: number | undefined;

    if (diarize) {
        const spk = await p.text({
            message: "Expected speaker count (blank = auto-detect):",
            placeholder: "auto",
            validate(value) {
                if (value && !/^\d+$/.test(value.trim())) {
                    return "Enter a whole number or leave blank";
                }
            },
        });

        if (p.isCancel(spk)) {
            p.cancel("Cancelled");
            return;
        }

        const parsedSpk = spk?.trim() ? Number.parseInt(spk.trim(), 10) : undefined;
        speakers = parsedSpk && parsedSpk > 0 ? parsedSpk : undefined;
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
        diarize,
        speakers,
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
    .option("--provider <provider>", "AI provider (local-hf, cloud, openai, groq, openrouter, darwinkit, xai)")
    .option("--local", "Shorthand for --provider local-hf")
    .option("--format <format>", "Output format (text, json, srt, vtt)", "text")
    .option("--lang <language>", "Audio language (e.g. en, cs, de)")
    .option("--model <model>", "Model name/id to use")
    .option("-o, --output <path>", "Write output to file")
    .option("-c, --clipboard", "Copy output to clipboard")
    .option("--no-clean", "Disable repetition-loop cleanup (alias: --raw)")
    .option("--raw", "Alias for --no-clean")
    .option("--diarize", "Identify speakers (speaker diarization)")
    .option("--speakers <n>", "Expected speaker count (0/omit = auto-detect)", (v) => {
        const n = Number.parseInt(v, 10);

        return Number.isInteger(n) && n > 0 ? n : undefined;
    })
    .action(async (file: string | undefined, opts: TranscribeFlags) => {
        if (!file) {
            await interactiveMode();
            return;
        }

        const resolvedProvider = await ensureProviderResolved(opts);

        await runTranscription(file, { ...opts, provider: resolvedProvider });
    });

async function ensureProviderResolved(opts: TranscribeFlags): Promise<string | undefined> {
    if (opts.local) {
        return "local-hf";
    }

    if (opts.provider) {
        return opts.provider;
    }

    const available = await listAvailableTranscribeProviders();

    if (isInteractive()) {
        if (available.length === 0) {
            out.error(pc.red("No transcription providers are available."));
            out.error(pc.dim("Set one of: OPENAI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, X_AI_API_KEY"));
            out.error(pc.dim("…or install local-hf / darwinkit support."));
            process.exit(1);
        }

        const picked = await p.select({
            message: "Pick a transcription provider:",
            options: available.map((id) => ({ value: id, label: id })),
        });

        if (p.isCancel(picked)) {
            out.error(pc.yellow("Cancelled."));
            process.exit(1);
        }

        return picked as string;
    }

    const choices = available.length > 0 ? available.join("|") : "local-hf|cloud|openai|groq|openrouter|xai";
    out.error(pc.red("No --provider specified and not in an interactive terminal."));
    out.error(pc.dim(suggestCommand("tools transcribe", { add: ["--provider", `<${choices}>`] })));
    process.exit(1);
}

async function listAvailableTranscribeProviders(): Promise<string[]> {
    const all = getAllProviders();
    const supported: string[] = [];

    for (const provider of all) {
        if (!provider.supports("transcribe")) {
            continue;
        }

        if (await provider.isAvailable()) {
            supported.push(provider.type);
        }
    }

    return supported;
}

async function main(): Promise<void> {
    try {
        await runTool(program, { tool: "transcribe" });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        out.error(message);
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
