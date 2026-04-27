import logger from "@app/logger";
import { convertToWhisperWav } from "@app/utils/audio/converter";
import type { AIProviderType } from "@app/utils/config/ai.types";
import { SafeJSON } from "@app/utils/json";
import type {
    AITask,
    AITranscriptionProvider,
    OnSegment,
    TranscribeOptions,
    TranscriptionResult,
    TranscriptionSegment,
} from "../../types";
import { XAIClient } from "./XAIClient";

interface XAITranscriptionWord {
    text: string;
    start: number;
    end: number;
    speaker?: number;
}

interface XAITranscriptionResponse {
    text: string;
    language?: string;
    duration?: number;
    words?: XAITranscriptionWord[];
}

interface XAIWsTranscriptPartial {
    type: "transcript.partial";
    text: string;
    is_final: boolean;
    speech_final?: boolean;
    start?: number;
    duration?: number;
    words?: XAITranscriptionWord[];
}

interface XAIWsTranscriptDone {
    type: "transcript.done";
    text: string;
    duration?: number;
    words?: XAITranscriptionWord[];
}

interface XAIWsError {
    type: "error";
    message: string;
}

type XAIWsTranscriptEvent = { type: "transcript.created" } | XAIWsTranscriptPartial | XAIWsTranscriptDone | XAIWsError;

const SUPPORTED_TASKS: ReadonlySet<AITask> = new Set(["transcribe"]);

export class AIXAITranscriptionProvider implements AITranscriptionProvider {
    readonly type: AIProviderType = "xai";
    private readonly client = new XAIClient();

    async isAvailable(): Promise<boolean> {
        return this.client.isConfigured();
    }

    supports(task: AITask): boolean {
        return SUPPORTED_TASKS.has(task);
    }

    async transcribe(audio: Buffer, options?: TranscribeOptions): Promise<TranscriptionResult> {
        const form = new FormData();

        if (options?.language) {
            form.append("language", options.language);
            form.append("format", "true");
        }

        if (options?.diarize) {
            form.append("diarize", "true");
        }

        // file MUST be appended last per xAI docs.
        const blob = new Blob([new Uint8Array(audio)], { type: "audio/mpeg" });
        form.append("file", blob, "audio.mp3");

        const response = await this.client.fetch("/stt", { method: "POST", body: form });

        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new Error(`xAI STT failed: ${response.status} ${response.statusText} — ${body.slice(0, 500)}`);
        }

        const data = (await response.json()) as XAITranscriptionResponse;

        return {
            text: data.text,
            duration: data.duration,
            language: data.language,
            segments: wordsToSegments(data.words),
        };
    }

    async transcribeStream(audio: Buffer, options?: TranscribeOptions): Promise<TranscriptionResult> {
        this.client.requireKey();
        const wav = await convertToWhisperWav(audio);
        const pcm = stripWavHeader(wav);
        const sampleRate = 16_000;
        const bytesPer100ms = (sampleRate * 2) / 10;

        const params = new URLSearchParams({
            sample_rate: String(sampleRate),
            encoding: "pcm",
            interim_results: "false",
            endpointing: "10",
        });

        if (options?.language) {
            params.set("language", options.language);
        }

        if (options?.diarize) {
            params.set("diarize", "true");
        }

        return new Promise<TranscriptionResult>((resolve, reject) => {
            const ws = this.client.openWebSocket("/stt", params);
            const collectedSegments: TranscriptionSegment[] = [];
            let aggregatedText = "";
            let aggregatedDuration: number | undefined;
            let serverReady = false;
            let onSegmentCb: OnSegment | undefined = options?.onSegment;

            const fail = (err: Error): void => {
                onSegmentCb = undefined;
                try {
                    ws.close();
                } catch {
                    /* noop */
                }
                reject(err);
            };

            ws.addEventListener("error", () => fail(new Error("xAI STT WebSocket error")));
            ws.addEventListener("close", (ev) => {
                if (!serverReady) {
                    fail(new Error(`xAI STT WebSocket closed before ready (code ${ev.code})`));
                }
            });

            ws.addEventListener("message", (event) => {
                let parsed: XAIWsTranscriptEvent;

                try {
                    parsed = SafeJSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
                } catch (err) {
                    logger.debug(`xAI STT: malformed event: ${err}`);
                    return;
                }

                switch (parsed.type) {
                    case "transcript.created":
                        serverReady = true;
                        void streamPcmFrames(ws, pcm, bytesPer100ms).catch((err) => fail(err));
                        break;
                    case "transcript.partial":
                        if (parsed.is_final) {
                            const seg: TranscriptionSegment = {
                                text: parsed.text,
                                start: parsed.start ?? 0,
                                end: (parsed.start ?? 0) + (parsed.duration ?? 0),
                            };
                            collectedSegments.push(seg);
                            onSegmentCb?.(seg);
                        }
                        break;
                    case "transcript.done":
                        aggregatedText = parsed.text;
                        aggregatedDuration = parsed.duration;
                        try {
                            ws.close();
                        } catch {
                            /* noop */
                        }
                        resolve({
                            text: aggregatedText,
                            duration: aggregatedDuration,
                            segments:
                                wordsToSegments(parsed.words) ??
                                (collectedSegments.length > 0 ? collectedSegments : undefined),
                        });
                        break;
                    case "error":
                        fail(new Error(`xAI STT stream error: ${parsed.message}`));
                        break;
                }
            });
        });
    }
}

async function streamPcmFrames(ws: WebSocket, pcm: Buffer, frameBytes: number): Promise<void> {
    for (let offset = 0; offset < pcm.length; offset += frameBytes) {
        const frame = pcm.subarray(offset, Math.min(offset + frameBytes, pcm.length));

        if (ws.readyState !== WebSocket.OPEN) {
            return;
        }

        ws.send(new Uint8Array(frame));
        await new Promise((r) => setTimeout(r, 100));
    }

    if (ws.readyState === WebSocket.OPEN) {
        ws.send(SafeJSON.stringify({ type: "audio.done" }));
    }
}

function stripWavHeader(wav: Buffer): Buffer {
    if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
        return wav;
    }

    let offset = 12;

    while (offset + 8 <= wav.length) {
        const chunkId = wav.toString("ascii", offset, offset + 4);
        const chunkSize = wav.readUInt32LE(offset + 4);
        const dataStart = offset + 8;

        if (chunkId === "data") {
            return wav.subarray(dataStart, dataStart + chunkSize);
        }

        offset = dataStart + chunkSize;
    }

    return wav;
}

function wordsToSegments(words: XAITranscriptionWord[] | undefined): TranscriptionSegment[] | undefined {
    if (!words || words.length === 0) {
        return undefined;
    }

    return words.map((w) => ({ text: w.text, start: w.start, end: w.end }));
}
