import { existsSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import logger from "@app/logger";
import { AI } from "@app/utils/ai/index";
import type { AIProviderType } from "@app/utils/ai/types";
import { formatDuration } from "@app/utils/format";
import { SafeJSON } from "@app/utils/json";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";
import { type TranscriptResponse, YoutubeTranscript } from "youtube-transcript";

interface TranscribeOptions {
    forceTranscribe?: boolean;
    format?: "text" | "json" | "srt" | "vtt";
    lang?: string;
    provider?: string;
    output?: string;
}

export interface CaptionSegment {
    text: string;
    start: number;
    end: number;
}

interface CaptionResult {
    text: string;
    segments: CaptionSegment[];
    lang?: string;
}

export function extractVideoId(url: string): string | null {
    const patterns = [
        /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
        /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
        /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
        /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
        /^([a-zA-Z0-9_-]{11})$/,
    ];

    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) {
            return match[1];
        }
    }

    return null;
}

async function getCaptions(url: string, lang?: string): Promise<CaptionResult | null> {
    try {
        const config = lang ? { lang } : undefined;
        const transcript: TranscriptResponse[] = await YoutubeTranscript.fetchTranscript(url, config);

        if (!transcript.length) {
            return null;
        }

        const segments: CaptionSegment[] = transcript.map((t) => ({
            text: t.text,
            start: t.offset / 1000,
            end: (t.offset + t.duration) / 1000,
        }));

        return {
            text: segments.map((s) => s.text).join(" "),
            segments,
            lang: lang ?? transcript[0]?.lang,
        };
    } catch {
        return null;
    }
}

async function checkYtDlp(): Promise<boolean> {
    try {
        const proc = Bun.spawn(["yt-dlp", "--version"], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        await proc.exited;
        return proc.exitCode === 0;
    } catch {
        return false;
    }
}

async function downloadAudio(url: string, onProgress?: (message: string) => void): Promise<string> {
    const outputPath = join(tmpdir(), `yt-audio-${Date.now()}.wav`);

    const proc = Bun.spawn(
        [
            "yt-dlp",
            "-x",
            "--audio-format",
            "wav",
            "--postprocessor-args",
            "ffmpeg:-ar 16000 -ac 1",
            "-o",
            outputPath,
            "--no-playlist",
            "--newline",
            url,
        ],
        {
            stdio: ["ignore", "pipe", "pipe"],
        }
    );

    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    let stderrBuffer = "";
    let stderrFull = "";

    while (true) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        const text = decoder.decode(value, { stream: true });
        stderrFull += text;
        stderrBuffer += text;

        const lines = stderrBuffer.split("\n");
        stderrBuffer = lines.pop() ?? "";

        for (const line of lines) {
            const progressMatch = line.match(/\[download\]\s+(\d+(?:\.\d+)?%)/);

            if (progressMatch) {
                onProgress?.(`Downloading... ${progressMatch[1]}`);
            }
        }
    }

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
        throw new Error(`yt-dlp failed: ${stderrFull.trim()}`);
    }

    if (!existsSync(outputPath)) {
        throw new Error("yt-dlp completed but audio file was not created");
    }

    return outputPath;
}

export function formatTimestamp(seconds: number): string {
    const totalMs = Math.round(seconds * 1000);
    const hours = Math.floor(totalMs / 3_600_000);
    const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
    const secs = Math.floor((totalMs % 60_000) / 1000);
    const ms = totalMs % 1000;

    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
}

export function toSRT(segments: CaptionSegment[]): string {
    return segments
        .map((seg, i) => {
            const start = formatTimestamp(seg.start).replace(".", ",");
            const end = formatTimestamp(seg.end).replace(".", ",");
            return `${i + 1}\n${start} --> ${end}\n${seg.text}`;
        })
        .join("\n\n");
}

export function toVTT(segments: CaptionSegment[]): string {
    const cues = segments
        .map((seg) => {
            const start = formatTimestamp(seg.start);
            const end = formatTimestamp(seg.end);
            return `${start} --> ${end}\n${seg.text}`;
        })
        .join("\n\n");

    return `WEBVTT\n\n${cues}`;
}

function formatOutput(result: CaptionResult, format: TranscribeOptions["format"]): string {
    switch (format) {
        case "json":
            return SafeJSON.stringify(
                {
                    text: result.text,
                    segments: result.segments,
                    lang: result.lang,
                },
                null,
                2
            );
        case "srt":
            return toSRT(result.segments);
        case "vtt":
            return toVTT(result.segments);
        default:
            return result.text;
    }
}

async function transcribeAction(urlArg: string | undefined, options: TranscribeOptions, cmd: Command): Promise<void> {
    let url = urlArg;

    if (!url) {
        if (!process.stdin.isTTY) {
            cmd.outputHelp();
            process.exit(0);
        }

        p.intro(pc.bgCyan(pc.black(" youtube transcribe ")));

        const result = await p.text({
            message: "Enter YouTube URL or video ID:",
            placeholder: "https://www.youtube.com/watch?v=...",
            validate: (value) => {
                if (!value || !value.trim()) {
                    return "URL is required";
                }

                if (!extractVideoId(value.trim())) {
                    return "Invalid YouTube URL or video ID";
                }
            },
        });

        if (p.isCancel(result)) {
            p.cancel("Operation cancelled");
            process.exit(0);
        }

        url = result;

        const providerChoice = await p.select({
            message: "Transcription provider (for audio fallback):",
            options: [
                { value: undefined, label: "Default", hint: "use configured provider" },
                { value: "local-hf", label: "Local (Hugging Face)", hint: "runs locally via transformers.js" },
                { value: "cloud", label: "Cloud", hint: "Groq/OpenAI Whisper API" },
            ],
        });

        if (p.isCancel(providerChoice)) {
            p.cancel("Operation cancelled");
            process.exit(0);
        }

        if (providerChoice) {
            options.provider = providerChoice as string;
        }

        const formatChoice = await p.select({
            message: "Output format:",
            options: [
                { value: "text" as const, label: "Plain text" },
                { value: "json" as const, label: "JSON", hint: "full result with segments" },
                { value: "srt" as const, label: "SRT", hint: "SubRip subtitle format" },
                { value: "vtt" as const, label: "VTT", hint: "WebVTT subtitle format" },
            ],
        });

        if (p.isCancel(formatChoice)) {
            p.cancel("Operation cancelled");
            process.exit(0);
        }

        options.format = formatChoice;

        const destination = await p.select({
            message: "Output to:",
            options: [
                { value: "stdout", label: "Terminal (stdout)" },
                { value: "file", label: "File" },
            ],
        });

        if (p.isCancel(destination)) {
            p.cancel("Operation cancelled");
            process.exit(0);
        }

        if (destination === "file") {
            const outPath = await p.text({
                message: "Output file path:",
                placeholder: "/path/to/output.txt",
            });

            if (p.isCancel(outPath)) {
                p.cancel("Operation cancelled");
                process.exit(0);
            }

            options.output = outPath;
        }
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
        p.log.error("Invalid YouTube URL or video ID");
        process.exit(1);
    }

    const format = options.format ?? "text";
    const spinner = p.spinner();

    if (!options.forceTranscribe) {
        spinner.start("Checking for captions...");

        const captions = await getCaptions(url, options.lang);
        if (captions) {
            spinner.stop(pc.green("Captions found!"));

            const output = formatOutput(captions, format);

            if (options.output) {
                await Bun.write(options.output, output);
                p.log.success(`Written to ${options.output}`);
            } else {
                console.log(output);
            }

            return;
        }

        spinner.stop(pc.yellow("No captions available"));
    }

    spinner.start("Checking yt-dlp availability...");

    const hasYtDlp = await checkYtDlp();
    if (!hasYtDlp) {
        spinner.stop(pc.red("yt-dlp not found"));
        p.log.error(`yt-dlp is required for audio transcription. Install with: ${pc.cyan("brew install yt-dlp")}`);
        process.exit(1);
    }

    spinner.stop("yt-dlp available");

    let audioPath: string | null = null;

    try {
        spinner.start("Downloading audio from YouTube...");
        audioPath = await downloadAudio(url, (msg) => spinner.message(msg));
        spinner.stop("Audio downloaded");

        spinner.start("Transcribing audio...");
        const startTime = Date.now();
        const audioBuffer = readFileSync(audioPath);

        const transcriber = await AI.Transcriber.create({
            provider: options.provider as AIProviderType | undefined,
        });

        try {
            const transcription = await transcriber.transcribe(audioBuffer, {
                language: options.lang,
                onProgress: (info) => {
                    spinner.message(info.message);
                },
            });

            const elapsed = Date.now() - startTime;
            spinner.stop(`Transcribed in ${formatDuration(elapsed)}`);

            const result: CaptionResult = {
                text: transcription.text,
                segments:
                    transcription.segments?.map((s) => ({
                        text: s.text,
                        start: s.start,
                        end: s.end,
                    })) ?? [],
                lang: transcription.language ?? options.lang,
            };

            if ((format === "srt" || format === "vtt") && result.segments.length === 0) {
                throw new Error(
                    "Subtitle output requires timestamped segments. Use --format text or --format json instead."
                );
            }

            const output = formatOutput(result, format);

            if (options.output) {
                await Bun.write(options.output, output);
                p.log.success(`Written to ${options.output}`);
            } else {
                console.log(output);
            }
        } finally {
            transcriber.dispose();
        }
    } catch (error) {
        spinner.stop(pc.red("Transcription failed"));
        const message = error instanceof Error ? error.message : String(error);
        p.log.error(message);
        logger.error({ error, url }, "YouTube transcription failed");
        process.exitCode = 1;
    } finally {
        if (audioPath && existsSync(audioPath)) {
            await unlink(audioPath).catch(() => {});
        }
    }
}

export function createTranscribeCommand(): Command {
    const cmd = new Command("transcribe")
        .description("Transcribe a YouTube video (captions or audio)")
        .argument("[url]", "YouTube URL or video ID")
        .option("--force-transcribe", "Skip caption check, always use audio transcription")
        .option("--format <format>", "Output format: text, json, srt, vtt", "text")
        .option("--lang <language>", "Preferred language (ISO code, e.g. en, cs)")
        .option("--provider <provider>", "Transcription provider (for audio fallback)")
        .option("-o, --output <path>", "Write output to file")
        .action(async (urlArg: string | undefined, opts: TranscribeOptions) => {
            await transcribeAction(urlArg, opts, cmd);
        });

    return cmd;
}
