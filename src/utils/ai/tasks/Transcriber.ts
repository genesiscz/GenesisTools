import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audioProcessor } from "@app/ask/audio/AudioProcessor";
import { AIConfig } from "../AIConfig";
import { getProviderForTask } from "../providers";
import type { AITranscriptionProvider, TranscribeOptions, TranscriptionResult, TranscriptionSegment } from "../types";

const MAX_CLOUD_BYTES = 24 * 1024 * 1024;

export class Transcriber {
    private provider: AITranscriptionProvider;

    private constructor(provider: AITranscriptionProvider) {
        this.provider = provider;
    }

    static async create(options?: { provider?: string; model?: string }): Promise<Transcriber> {
        const config = await AIConfig.load();

        if (options?.provider) {
            const providerType = options.provider as "cloud" | "local-hf" | "darwinkit";
            config.set("transcribe", { provider: providerType, model: options.model });
        }

        const provider = await getProviderForTask("transcribe", config);

        if (!("transcribe" in provider)) {
            throw new Error(`Provider "${provider.type}" does not support transcription`);
        }

        return new Transcriber(provider as AITranscriptionProvider);
    }

    async transcribe(audioOrPath: Buffer | string, options?: TranscribeOptions): Promise<TranscriptionResult> {
        let audio: Buffer;

        if (typeof audioOrPath === "string") {
            const file = Bun.file(audioOrPath);
            const arrayBuffer = await file.arrayBuffer();
            audio = Buffer.from(arrayBuffer);
        } else {
            audio = audioOrPath;
        }

        if (this.provider.type === "cloud" && audio.length > MAX_CLOUD_BYTES) {
            return this.transcribeChunked(audio, typeof audioOrPath === "string" ? audioOrPath : undefined, options);
        }

        return this.provider.transcribe(audio, options);
    }

    private async transcribeChunked(
        audio: Buffer,
        sourcePath: string | undefined,
        options?: TranscribeOptions
    ): Promise<TranscriptionResult> {
        const chunkDir = join(tmpdir(), `transcribe-chunks-${Date.now()}`);
        let inputPath = sourcePath;

        try {
            if (!inputPath) {
                inputPath = join(tmpdir(), `transcribe-input-${Date.now()}.wav`);
                await writeFile(inputPath, audio);
            }

            options?.onProgress?.({ phase: "transcribe", message: "Splitting large audio for cloud upload..." });
            const chunkPaths = await audioProcessor.splitAudioBySize(inputPath, chunkDir, MAX_CLOUD_BYTES);

            const allSegments: TranscriptionSegment[] = [];
            const texts: string[] = [];
            let timeOffset = 0;

            for (let i = 0; i < chunkPaths.length; i++) {
                options?.onProgress?.({
                    phase: "transcribe",
                    percent: Math.round((i / chunkPaths.length) * 100),
                    message: `Transcribing chunk ${i + 1}/${chunkPaths.length}...`,
                });

                const chunkBuf = await readFile(chunkPaths[i]);
                const result = await this.provider.transcribe(Buffer.from(chunkBuf), {
                    ...options,
                    onProgress: undefined,
                    onSegment: undefined,
                });

                texts.push(result.text);

                if (result.segments) {
                    for (const seg of result.segments) {
                        const adjusted: TranscriptionSegment = {
                            text: seg.text,
                            start: seg.start + timeOffset,
                            end: seg.end + timeOffset,
                        };
                        allSegments.push(adjusted);
                        options?.onSegment?.(adjusted);
                    }
                }

                if (result.duration) {
                    timeOffset += result.duration;
                } else if (result.segments?.length) {
                    timeOffset = result.segments[result.segments.length - 1].end;
                }
            }

            return {
                text: texts.join(" "),
                segments: allSegments.length > 0 ? allSegments : undefined,
                language: options?.language,
                duration: timeOffset > 0 ? timeOffset : undefined,
            };
        } finally {
            if (!sourcePath && inputPath && existsSync(inputPath)) {
                await rm(inputPath, { force: true }).catch(() => {});
            }

            if (existsSync(chunkDir)) {
                await rm(chunkDir, { recursive: true, force: true }).catch(() => {});
            }
        }
    }

    dispose(): void {
        this.provider.dispose?.();
    }
}
