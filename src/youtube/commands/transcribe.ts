import { isInteractive, suggestCommand } from "@app/utils/cli/executor";
import { SafeJSON } from "@app/utils/json";
import { getYoutube } from "@app/youtube/commands/_shared/ensure-pipeline";
import { renderOrEmit } from "@app/youtube/commands/_shared/render";
import { extractVideoId, formatTimestamp } from "@app/youtube/commands/_shared/utils";
import type { Transcript, TranscriptSegment, VideoId } from "@app/youtube/lib/types";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

interface TranscribeOptions {
    forceTranscribe?: boolean;
    format?: "text" | "json" | "srt" | "vtt";
    lang?: string;
    provider?: string;
    output?: string;
    cache?: boolean;
}

export type CaptionSegment = TranscriptSegment;

export { extractVideoId, formatTimestamp };

export function toSRT(segments: CaptionSegment[]): string {
    return segments
        .map((segment, index) => {
            const start = formatTimestamp(segment.start).replace(".", ",");
            const end = formatTimestamp(segment.end).replace(".", ",");

            return `${index + 1}\n${start} --> ${end}\n${segment.text}`;
        })
        .join("\n\n");
}

export function toVTT(segments: CaptionSegment[]): string {
    const cues = segments
        .map((segment) => {
            const start = formatTimestamp(segment.start);
            const end = formatTimestamp(segment.end);

            return `${start} --> ${end}\n${segment.text}`;
        })
        .join("\n\n");

    return `WEBVTT\n\n${cues}`;
}

export function registerTranscribeCommand(program: Command): void {
    const cmd = program
        .command("transcribe")
        .description("Transcribe a YouTube video (captions or audio)")
        .argument("[url]", "YouTube URL or 11-char video ID")
        .option("--force-transcribe", "Skip caption check, always run AI transcription")
        .option("--format <format>", "Output: text | json | srt | vtt", "text")
        .option("--lang <code>", "Preferred language (ISO, e.g. en, cs)")
        .option("--provider <provider>", "Override AI provider for transcription")
        .option("-o, --output <path>", "Write the chosen format to a file")
        .option("--no-cache", "Bypass cached transcript")
        .addHelpText("after", buildTranscribeExamples())
        .action(async (urlArg: string | undefined, opts: TranscribeOptions) => {
            await runTranscribe({ urlArg, opts, cmd });
        });
}

export function createTranscribeCommand(): Command {
    const program = new Command();
    registerTranscribeCommand(program);

    const command = program.commands[0];
    if (!command) {
        throw new Error("failed to create transcribe command");
    }

    return command;
}

async function runTranscribe({
    urlArg,
    opts,
    cmd,
}: {
    urlArg?: string;
    opts: TranscribeOptions;
    cmd: Command;
}): Promise<void> {
    const url = await resolveInput(urlArg, opts, cmd);

    if (!url) {
        return;
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
        console.error(pc.red("Invalid YouTube URL or video ID"));
        process.exitCode = 1;
        return;
    }

    const yt = await getYoutube();
    await yt.videos.ensureMetadata(videoId);
    const transcript =
        opts.cache === false ? null : yt.db.getTranscript(videoId, { preferLang: opts.lang ? [opts.lang] : undefined });
    const result =
        transcript ??
        (await yt.transcripts.transcribe({
            videoId,
            forceTranscribe: opts.forceTranscribe || opts.cache === false,
            lang: opts.lang,
            provider: opts.provider,
            persistProvider: Boolean(opts.provider),
            onProgress: (info) => {
                if (cmd.optsWithGlobals().silent) {
                    return;
                }

                process.stderr.write(`${info.message}\n`);
            },
        }));
    const format = normalizeFormat(opts.format);
    const output = formatTranscript(result, format);

    if (opts.output) {
        await Bun.write(opts.output, output);
        if (!cmd.optsWithGlobals().silent) {
            process.stderr.write(`Written to ${opts.output}\n`);
        }
        return;
    }

    await renderOrEmit({
        text: output,
        json: transcriptToJson(result),
        flags: { ...cmd.optsWithGlobals(), json: cmd.optsWithGlobals().json || format === "json" },
    });
}

async function resolveInput(
    urlArg: string | undefined,
    opts: TranscribeOptions,
    _cmd: Command
): Promise<string | null> {
    if (urlArg) {
        return urlArg;
    }

    if (!isInteractive()) {
        console.error(pc.red("transcribe requires a YouTube URL or video ID in non-interactive mode."));
        console.error(`Try: ${suggestCommand("tools youtube transcribe", { add: ["dQw4w9WgXcQ"] })}`);
        process.exitCode = 1;
        return null;
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
        return null;
    }

    const providerChoice = await p.select({
        message: "Transcription provider (for audio fallback):",
        options: [
            { value: "", label: "Default", hint: "use configured provider" },
            { value: "local-hf", label: "Local (Hugging Face)", hint: "runs locally via transformers.js" },
            { value: "cloud", label: "Cloud", hint: "Groq/OpenAI Whisper API" },
        ],
    });

    if (p.isCancel(providerChoice)) {
        p.cancel("Operation cancelled");
        return null;
    }

    if (providerChoice) {
        opts.provider = providerChoice;
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
        return null;
    }

    opts.format = formatChoice;
    const destination = await p.select({
        message: "Output to:",
        options: [
            { value: "stdout", label: "Terminal (stdout)" },
            { value: "file", label: "File" },
        ],
    });

    if (p.isCancel(destination)) {
        p.cancel("Operation cancelled");
        return null;
    }

    if (destination === "file") {
        const outPath = await p.text({
            message: "Output file path:",
            placeholder: "/path/to/output.txt",
        });

        if (p.isCancel(outPath)) {
            p.cancel("Operation cancelled");
            return null;
        }

        opts.output = outPath;
    }

    return result;
}

function normalizeFormat(value: TranscribeOptions["format"]): NonNullable<TranscribeOptions["format"]> {
    if (value === "json" || value === "srt" || value === "vtt" || value === "text" || value === undefined) {
        return value ?? "text";
    }

    throw new Error(`Unsupported transcript format: ${value}`);
}

function formatTranscript(transcript: Transcript, format: NonNullable<TranscribeOptions["format"]>): string {
    switch (format) {
        case "json":
            return SafeJSON.stringify(transcriptToJson(transcript), null, 2);
        case "srt":
            return toSRT(transcript.segments);
        case "vtt":
            return toVTT(transcript.segments);
        case "text":
            return transcript.text;
    }
}

function transcriptToJson(transcript: Transcript): {
    text: string;
    segments: TranscriptSegment[];
    lang: string;
    source: string;
    videoId: VideoId;
} {
    return {
        text: transcript.text,
        segments: transcript.segments,
        lang: transcript.lang,
        source: transcript.source,
        videoId: transcript.videoId,
    };
}

function buildTranscribeExamples(): string {
    return "\nExamples:\n  $ tools youtube transcribe https://youtu.be/dQw4w9WgXcQ\n  $ tools youtube transcribe dQw4w9WgXcQ --format srt -o /tmp/out.srt\n  $ tools youtube transcribe dQw4w9WgXcQ --force-transcribe --provider local-hf\n";
}
