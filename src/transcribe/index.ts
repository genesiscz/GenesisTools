#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { type AcquiredAudio, acquireRemoteAudio } from "@app/transcribe/lib/acquire";
import { type ClassifiedSource, classifySource, type RemoteSource } from "@app/transcribe/lib/drivers";
import { formatUsd } from "@app/transcribe/lib/price";
import { type PriceQuote, priceQuote, unsupportedYoutubeFlags } from "@app/transcribe/lib/quote";
import { transcribeYoutubeSource } from "@app/transcribe/lib/youtube-source";
import * as p from "@clack/prompts";
import { getAllProviders } from "@genesiscz/utils/ai/providers/index.ts";
import { Transcriber } from "@genesiscz/utils/ai/tasks/Transcriber";
import {
    formatOutput,
    formatTimestamp,
    type OutputFormat,
    toSRT,
    toVTT,
} from "@genesiscz/utils/ai/transcription-format.ts";
import type { AIProviderType } from "@genesiscz/utils/ai/types.ts";
import { audioProcessor } from "@genesiscz/utils/ask/audio/AudioProcessor.ts";
import { runTool } from "@genesiscz/utils/cli";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli/executor.ts";
import { isQuietOutput } from "@genesiscz/utils/cli/output-mode.ts";
import { createQuietSpinner } from "@genesiscz/utils/cli/quiet-spinner.ts";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { copyToClipboard } from "@genesiscz/utils/clipboard.ts";
import { env } from "@genesiscz/utils/env";
import { formatBytes, formatDuration } from "@genesiscz/utils/format.ts";
import { out } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage";
import { createBoxTable, formatDotStatus } from "@genesiscz/utils/table";
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
    forceTranscribe?: boolean;
    priceOnly?: boolean;
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
        const transcriber = await Transcriber.create({
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

            await deliverOutput(formatOutput(result, format), opts);
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
    p.intro(pc.bgCyan(pc.black(` ${toolCommand("transcribe")} `)));

    const filePath = await p.text({
        message: "Audio file or URL:",
        placeholder: "/path/to/audio.mp3  or  https://x.com/user/status/123",
        validate(value) {
            if (!value) {
                return "File path or URL is required";
            }

            const classified = classifySource(value);

            if (classified.driver === "unsupported") {
                return classified.reason;
            }

            if (classified.driver !== "local") {
                return;
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
            ...(env.ai.openai.getKey() ? [{ value: "openai", label: "OpenAI", hint: "whisper-1" }] : []),
            ...(env.ai.groq.getKey() ? [{ value: "groq", label: "Groq", hint: "whisper-large-v3" }] : []),
            ...(env.ai.openrouter.getKey() ? [{ value: "openrouter", label: "OpenRouter" }] : []),
            ...(env.x.getApiKey() ? [{ value: "xai", label: "xAI (Grok)", hint: "grok-voice STT" }] : []),
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

    await transcribeInput(filePath, {
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
    .description("Transcribe a local audio file, or a YouTube, X, or direct media URL")
    .argument("[file]", "Audio file, or a YouTube / X / direct media URL")
    .option("--provider <provider>", "AI provider (local-hf, cloud, openai, groq, openrouter, darwinkit, xai)")
    .option("--force-transcribe", "YouTube only: skip captions and transcribe the audio")
    .option(
        "--price-only",
        "Price every transcription provider from the video's duration and do not download or transcribe. A real transcribe keeps the converted audio for 1 hour."
    )
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
    .addHelpText(
        "after",
        `\nExamples:\n  $ ${toolCommand("transcribe")} meeting.m4a\n  $ ${toolCommand("transcribe")} https://youtu.be/dQw4w9WgXcQ\n  $ ${toolCommand("transcribe")} https://x.com/user/status/123 --provider deepgram\n  $ ${toolCommand("transcribe")} https://cdn.example.com/talk.mp4\n`
    )
    .action(async (file: string | undefined, opts: TranscribeFlags) => {
        if (!file) {
            await interactiveMode();
            return;
        }

        await transcribeInput(file, opts);
    });

/** Providers that run on this Mac and need no account: their own availability check reads no AI config. */
async function printPrice(file: string, classified: ClassifiedSource, opts: TranscribeFlags): Promise<void> {
    let quote: PriceQuote;

    try {
        quote = await priceQuote({ file, classified, provider: opts.provider, local: opts.local, model: opts.model });
    } catch (error) {
        out.error(pc.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
    }

    for (const problem of quote.problems) {
        out.error(pc.dim(problem));
    }

    if (opts.format === "json") {
        out.result({ durationSec: quote.durationSec, via: quote.via, quotes: quote.quotes });

        return;
    }

    out.error(
        pc.dim(
            `${formatDuration(quote.durationSec, "s", "hms")} from ${quote.via}. No media downloaded. A real transcribe keeps the converted audio for 1 hour.`
        )
    );
    const table = createBoxTable(["PROVIDER", "MODEL", "MODE", "$/HOUR", "THIS AUDIO", "HERE", "RUN"]);

    for (const row of quote.quotes) {
        table.push([
            row.provider,
            row.model,
            row.mode,
            formatUsd(row.usdPerHour),
            formatUsd(row.usd),
            formatDotStatus(row.available ? "ok" : "dim", row.available ? "yes" : "no"),
            row.run,
        ]);
    }

    out.println(table.toString());

    for (const row of quote.quotes) {
        if (!row.note) {
            continue;
        }

        out.error(pc.dim(`${row.provider} ${row.model} ${row.mode}: ${row.note}`));
    }

    if (classified.driver === "youtube") {
        out.error(pc.dim("YouTube captions, when the video has them, cost nothing. This table is the audio price."));
    }
}

async function transcribeInput(file: string, opts: TranscribeFlags): Promise<void> {
    const looksLikeLocalFile = !/^https?:\/\//i.test(file) && existsSync(resolve(file));
    const classified = looksLikeLocalFile ? { driver: "local" as const } : classifySource(file);

    if (classified.driver === "unsupported") {
        out.error(pc.red(classified.reason));
        process.exit(1);
    }

    if (opts.priceOnly) {
        await printPrice(file, classified, opts);

        return;
    }

    if (classified.driver === "youtube") {
        await runYoutube(classified.videoId, opts);

        return;
    }

    const provider = await ensureProviderResolved(opts);
    const flags = { ...opts, provider };

    if (classified.driver === "x" || classified.driver === "direct") {
        await runRemote(classified, flags);

        return;
    }

    await runTranscription(file, flags);
}

async function runYoutube(videoId: string, opts: TranscribeFlags): Promise<void> {
    const format = opts.format ?? "text";
    const quiet = isQuietOutput(format);
    const unsupported = unsupportedYoutubeFlags(opts);

    if (unsupported.length > 0) {
        out.error(pc.red(`YouTube sources do not support ${unsupported.join(", ")}.`));
        out.error(pc.dim("Use --provider, --local, --lang or --force-transcribe, or download the audio first."));
        process.exit(1);
    }

    try {
        const result = await transcribeYoutubeSource({
            videoId,
            lang: opts.lang,
            provider: opts.local ? "local-hf" : opts.provider,
            forceTranscribe: opts.forceTranscribe,
            onProgress: (message) => {
                if (!quiet) {
                    process.stderr.write(`${pc.dim(message)}\n`);
                }
            },
        });

        if (result.language) {
            out.error(pc.dim(`Language: ${result.language}`));
        }

        if (result.duration) {
            out.error(pc.dim(`Duration: ${formatDuration(result.duration, "s", "hms")}`));
        }

        await deliverOutput(formatOutput(result, format), opts);
    } catch (error) {
        out.error(pc.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
    }
}

async function runRemote(source: RemoteSource, opts: TranscribeFlags): Promise<void> {
    out.error(pc.dim(`Source: ${source.driver} ${source.url}`));
    let acquired: AcquiredAudio | undefined;

    try {
        const storage = new Storage("transcribe");
        await storage.ensureDirs();
        acquired = await acquireRemoteAudio(source, { cacheDir: storage.getCacheDir() });
        out.error(pc.dim(`Media: ${acquired.mediaUrl}`));
        await runTranscription(acquired.audioPath, opts);
    } catch (error) {
        out.error(pc.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
    } finally {
        await acquired?.cleanup();
    }
}

async function deliverOutput(output: string, opts: TranscribeFlags): Promise<void> {
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
}

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

// Guarded: this file is imported by transcribe.test.ts for its pure formatters.
// Without the guard the import RAN the CLI, which reached an interactive prompt
// and blocked forever — `bun run test` never finished, and CI reported a
// 4-minute timeout rather than a pass.
if (import.meta.main) {
    try {
        await main();
    } catch (err) {
        out.error(err instanceof Error ? err.message : String(err));
        await out.flush();
        process.exit(1);
    }
}
