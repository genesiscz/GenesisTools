import type { AIProviderType } from "@app/utils/config/ai.types";
import { listVoicesStructured, renderToBuffer } from "@app/utils/macos/tts";
import type { AITask, AITextToSpeechProvider, TTSOptions, TTSResult, TTSVoice } from "../types";

/**
 * macOS native TTS provider. Wraps the `say` command and exposes it via
 * AITextToSpeechProvider. The native speak() short-circuit emits audio
 * directly to speakers using the [[volm V]] inline directive — no temp
 * file, no ffplay, no buffer roundtrip.
 */
export class AIMacOSTextToSpeechProvider implements AITextToSpeechProvider {
    readonly type: AIProviderType = "macos";

    async isAvailable(): Promise<boolean> {
        return process.platform === "darwin";
    }

    supports(task: AITask): boolean {
        return task === "tts";
    }

    async synthesize(text: string, options?: TTSOptions): Promise<TTSResult> {
        const audio = await renderToBuffer(text, { voice: options?.voice });
        return { audio, contentType: "audio/x-aiff" };
    }

    /**
     * Synth-and-play in one call. Uses the [[volm V]] directive so we never
     * render to a temp file even when volume < 1.
     */
    async speak(
        text: string,
        options?: TTSOptions & { volume?: number; rate?: number; wait?: boolean }
    ): Promise<void> {
        const volume = clampVolume(options?.volume);
        const args: string[] = ["say"];

        if (options?.voice) {
            args.push("-v", options.voice);
        }

        if (options?.rate) {
            args.push("-r", String(options.rate));
        }

        args.push(`[[volm ${volume}]] ${text}`);

        const proc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });

        if (options?.wait) {
            await proc.exited;
        }
    }

    async listVoices(): Promise<TTSVoice[]> {
        const voices = await listVoicesStructured();
        return voices.map((v) => ({
            id: v.name,
            name: v.name,
            locale: v.locale,
            description: v.sample,
        }));
    }
}

function clampVolume(v: number | undefined): number {
    if (v == null) {
        return 1;
    }

    const normalized = v > 1 ? v / 100 : v;
    return Math.max(0, Math.min(1, normalized));
}
