import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "@app/utils/storage/storage.ts";
import { detectLanguage } from "./nlp";
import { SayConfigManager } from "./SayConfigManager.ts";

const storage = new Storage("say");

// ============================================
// Types
// ============================================

export interface VoiceInfo {
    name: string;
    locale: string; // "cs_CZ", "en_US"
    lang: string; // "cs", "en"
    sample: string;
}

export interface SpeakOptions {
    /** Override voice (skips language detection) */
    voice?: string;
    /** Words per minute (default: macOS default ~175) */
    rate?: number;
    /** Volume 0.0 - 1.0, default: 1 */
    volume?: number;
    /** Block until done, default: false */
    wait?: boolean;
    /** Caller identity for per-app mute */
    app?: string;
}

/**
 * Normalize volume: if <= 1, treat as 0.0–1.0 range.
 * If > 1, treat as percentage (e.g. 50 → 0.5).
 * Clamps result to [0, 1].
 */
export function normalizeVolume(v: number): number {
    const normalized = v > 1 ? v / 100 : v;
    return Math.max(0, Math.min(1, normalized));
}

// ============================================
// Voice Map (dynamic, cached)
// ============================================

let cachedVoiceMap: Map<string, VoiceInfo> | null = null;

/**
 * Parse `say -v ?` output into a map of lang -> VoiceInfo.
 * Each line looks like: "Zuzana              cs_CZ    # Dobrý den, jmenuji se Zuzana."
 * Returns a map keyed by language code (first voice per language wins).
 */
export async function getVoiceMap(): Promise<Map<string, VoiceInfo>> {
    if (cachedVoiceMap) {
        return cachedVoiceMap;
    }

    // Try storage cache first (voices rarely change)
    const cached = await storage.getCacheFile<Array<[string, VoiceInfo]>>("voice-map.json", "7 days");

    if (cached) {
        cachedVoiceMap = new Map(cached);
        return cachedVoiceMap;
    }

    const proc = Bun.spawn(["say", "-v", "?"], { stdout: "pipe", stderr: "ignore" });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const map = new Map<string, VoiceInfo>();
    const lines = output.split("\n").filter(Boolean);

    for (const line of lines) {
        // Format: "Name                locale   # Sample text"
        const match = line.match(/^(\S+)\s+(\S+)\s+#\s*(.*)$/);

        if (!match) {
            continue;
        }

        const [, name, locale, sample] = match;
        const lang = locale.split("_")[0];

        // First voice per language wins (they're listed in preference order)
        if (!map.has(lang)) {
            map.set(lang, { name, locale, lang, sample });
        }
    }

    // Persist to cache
    await storage.putCacheFile("voice-map.json", Array.from(map.entries()), "7 days");
    cachedVoiceMap = map;
    return map;
}

// ============================================
// Core TTS
// ============================================

/**
 * Speak text aloud, resolving voice/volume/etc. through the v2 SayConfig profile
 * for `options.app` (falls back to the "default" profile). Caller-supplied
 * options override profile values. Background by default; `wait: true` blocks.
 */
export async function speak(text: string, options?: SpeakOptions): Promise<void> {
    const mgr = new SayConfigManager();

    if (await mgr.isMuted(options?.app)) {
        process.stderr.write("[say] muted\n");
        return;
    }

    const profile = await mgr.resolveApp(options?.app);
    const rawVolume = options?.volume ?? profile.volume ?? 1;
    const volume = normalizeVolume(rawVolume);

    // Dynamic import avoids a circular module init:
    // AIMacOSTextToSpeechProvider -> tts.ts (renderToBuffer, listVoicesStructured)
    // tts.ts -> ai/index -> AIMacOSTextToSpeechProvider
    const { AI } = await import("@app/utils/ai/index");
    await AI.speak(text, {
        provider: "local",
        voice: options?.voice ?? profile.voice ?? undefined,
        rate: options?.rate ?? profile.rate ?? undefined,
        volume,
        wait: options?.wait,
    });
}

export interface PlayAudioOptions {
    /** Playback volume 0.0-1.0 (passed to `afplay -v`). */
    volume?: number;
    /** Block until playback finishes. */
    wait?: boolean;
    /** Delete the file after playback. */
    cleanup?: boolean;
}

/**
 * Play an audio file via macOS `afplay`. Used by both the macOS TTS path
 * (volume-attenuated AIFF) and the xAI TTS path (mp3/wav from the API).
 */
export async function playAudioFile(path: string, options?: PlayAudioOptions): Promise<void> {
    const args = ["afplay"];

    if (options?.volume != null) {
        args.push("-v", String(options.volume));
    }

    args.push(path);

    const proc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });

    const finalize = (): void => {
        if (options?.cleanup) {
            cleanupTmpFile(path);
        }
    };

    if (options?.wait) {
        await proc.exited;
        finalize();
    } else {
        proc.exited.then(finalize);
    }
}

/**
 * Render text to an audio buffer using macOS `say -o`. Returns AIFF bytes.
 * Used by AIMacosProvider.synthesize() so the macOS path goes through the
 * same AITextToSpeechProvider interface as cloud providers.
 */
export async function renderToBuffer(text: string, options?: { voice?: string; rate?: number }): Promise<Buffer> {
    const tmpFile = join(tmpdir(), `genesis-say-render-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.aiff`);
    const args = ["say"];

    let voiceName = options?.voice ?? null;

    if (!voiceName) {
        voiceName = await detectVoiceForText(text);
    }

    if (voiceName) {
        args.push("-v", voiceName);
    }

    if (options?.rate) {
        args.push("-r", String(options.rate));
    }

    args.push("-o", tmpFile, text);

    const proc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
    await proc.exited;

    if (!existsSync(tmpFile)) {
        throw new Error("macOS `say` failed to produce output file");
    }

    try {
        const file = Bun.file(tmpFile);
        return Buffer.from(await file.arrayBuffer());
    } finally {
        cleanupTmpFile(tmpFile);
    }
}

async function detectVoiceForText(text: string): Promise<string | null> {
    try {
        const result = await detectLanguage(text);
        const voiceMap = await getVoiceMap();
        const voice = voiceMap.get(result.language);
        return voice?.name ?? null;
    } catch {
        return null;
    }
}

function cleanupTmpFile(path: string): void {
    try {
        if (existsSync(path)) {
            unlinkSync(path);
        }
    } catch {
        // Best-effort cleanup
    }
}

// ============================================
// List voices
// ============================================

/** List available voices on this system (raw lines from `say -v ?`) */
export async function listVoices(): Promise<string[]> {
    const proc = Bun.spawn(["say", "-v", "?"], { stdout: "pipe", stderr: "ignore" });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output.split("\n").filter(Boolean);
}

/** List voices as structured data */
export async function listVoicesStructured(): Promise<VoiceInfo[]> {
    const voiceMap = await getVoiceMap();
    return Array.from(voiceMap.values());
}
