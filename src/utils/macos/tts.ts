import { detectLanguage } from "./nlp";

/** BCP-47 language code → macOS say voice name */
const VOICE_MAP: Record<string, string> = {
    cs: "Zuzana",
    sk: "Laura",
    en: "Samantha",
    de: "Anna",
    fr: "Thomas",
    es: "Monica",
    it: "Alice",
    pl: "Zosia",
    pt: "Joana",
    ru: "Milena",
    uk: "Lesya",
    ja: "Kyoko",
    ko: "Yuna",
    zh: "Ting-Ting",
};

export interface SpeakOptions {
    /** Override voice (skips language detection) */
    voice?: string;
    /** Words per minute (default: macOS default ~175) */
    rate?: number;
}

/**
 * Speak text aloud using macOS `say` command.
 * Automatically detects language and selects appropriate voice.
 */
export async function speak(text: string, options?: SpeakOptions): Promise<void> {
    const args = ["say"];

    if (options?.voice) {
        args.push("-v", options.voice);
    } else {
        try {
            const result = await detectLanguage(text);
            const voice = VOICE_MAP[result.language];

            if (voice) {
                args.push("-v", voice);
            }
        } catch {
            // Fall through to default system voice
        }
    }

    if (options?.rate) {
        args.push("-r", String(options.rate));
    }

    args.push(text);

    const proc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
}

/** List available voices on this system */
export async function listVoices(): Promise<string[]> {
    const proc = Bun.spawn(["say", "-v", "?"], { stdout: "pipe", stderr: "ignore" });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output.split("\n").filter(Boolean);
}
