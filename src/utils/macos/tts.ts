import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "@app/utils/storage/storage.ts";
import { detectLanguage } from "./nlp";

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

export interface SayConfig {
    defaultVoice: string | null;
    defaultVolume: number;
    globalMute: boolean;
    appMute: Record<string, boolean>;
    appVolume: Record<string, number>;
}

const DEFAULT_CONFIG: SayConfig = {
    defaultVoice: null,
    defaultVolume: 1,
    globalMute: false,
    appMute: {},
    appVolume: {},
};

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
// Config helpers
// ============================================

async function getConfig(): Promise<SayConfig> {
    const config = await storage.getConfig<SayConfig>();
    return { ...DEFAULT_CONFIG, ...config };
}

export async function setConfig(config: SayConfig): Promise<void> {
    await storage.setConfig(config);
}

export async function getConfigForRead(): Promise<SayConfig> {
    return getConfig();
}

// ============================================
// Mute helpers
// ============================================

function isMuted(config: SayConfig, app?: string): boolean {
    if (app && app in config.appMute) {
        return config.appMute[app];
    }

    return config.globalMute;
}

export async function setMute(muted: boolean, app?: string): Promise<void> {
    const config = await getConfig();

    if (app) {
        config.appMute[app] = muted;
    } else {
        config.globalMute = muted;
    }

    await setConfig(config);
}

// ============================================
// Core TTS
// ============================================

/**
 * Speak text aloud using macOS `say` command.
 * Automatically detects language and selects appropriate voice.
 * Supports volume control via render-to-AIFF + afplay.
 * Background by default; use `wait: true` to block.
 */
export async function speak(text: string, options?: SpeakOptions): Promise<void> {
    const config = await getConfig();

    // Check mute status
    if (isMuted(config, options?.app)) {
        process.stderr.write("[say] muted\n");
        return;
    }

    // Auto-create app entry on first use + save per-app volume
    const app = options?.app;
    let configDirty = false;

    if (app && !(app in config.appMute)) {
        config.appMute[app] = false;
        configDirty = true;
    }

    if (app && options?.volume != null) {
        config.appVolume[app] = normalizeVolume(options.volume);
        configDirty = true;
    }

    if (configDirty) {
        await setConfig(config);
    }

    const rawVolume = options?.volume ?? (app ? config.appVolume[app] : undefined) ?? config.defaultVolume ?? 1;
    const volume = normalizeVolume(rawVolume);
    const useAfplay = volume < 1;

    // Build say args
    const sayArgs = ["say"];

    // Voice selection
    if (options?.voice) {
        sayArgs.push("-v", options.voice);
    } else {
        const voiceName = config.defaultVoice ?? (await detectVoiceForText(text));

        if (voiceName) {
            sayArgs.push("-v", voiceName);
        }
    }

    if (options?.rate) {
        sayArgs.push("-r", String(options.rate));
    }

    if (useAfplay) {
        // Render to AIFF, then play with volume via afplay
        const tmpFile = join(tmpdir(), `genesis-say-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.aiff`);
        sayArgs.push("-o", tmpFile);
        sayArgs.push(text);

        const sayProc = Bun.spawn(sayArgs, { stdout: "ignore", stderr: "ignore" });
        await sayProc.exited;

        if (!existsSync(tmpFile)) {
            return;
        }

        const afplayArgs = ["afplay", "-v", String(volume), tmpFile];
        const afplayProc = Bun.spawn(afplayArgs, { stdout: "ignore", stderr: "ignore" });

        if (options?.wait) {
            await afplayProc.exited;
            cleanupTmpFile(tmpFile);
        } else {
            // Clean up after playback finishes in background
            afplayProc.exited.then(() => cleanupTmpFile(tmpFile));
        }
    } else {
        // Direct say (volume = 1, no need for afplay)
        sayArgs.push(text);
        const proc = Bun.spawn(sayArgs, { stdout: "ignore", stderr: "ignore" });

        if (options?.wait) {
            await proc.exited;
        }
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
