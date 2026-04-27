#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import logger from "@app/logger";
import { getProvider, getTextToSpeechProvider } from "@app/utils/ai/providers";
import type { AITextToSpeechProvider, TTSOptions, TTSResult } from "@app/utils/ai/types";
import { suggestCommand } from "@app/utils/cli/executor";
import type { SayConfig } from "@app/utils/macos/tts.ts";
import {
    getConfigForRead,
    listVoicesStructured,
    normalizeVolume,
    playAudioFile,
    setConfig,
    setMute,
    speak,
} from "@app/utils/macos/tts.ts";
import { formatTable } from "@app/utils/table.ts";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

const REST_TTS_LIMIT = 15_000;

type SayProvider = "macos" | "xai";

interface SayOptions {
    volume?: number;
    /** `true` when `--voice` was passed without an argument — triggers voice listing. */
    voice?: string | true;
    rate?: number;
    wait?: boolean;
    app?: string;
    mute?: boolean;
    unmute?: boolean;
    provider?: SayProvider;
    language?: string;
    format?: "mp3" | "wav";
    file?: string;
    stream?: boolean;
}

const program = new Command()
    .name("say")
    .description(
        "Text-to-speech with volume control, auto language detection, mute, and pluggable backends (macOS, xAI Grok)"
    )
    .argument("[message...]", "Text to speak (omit to read --file or enter interactive mode)")
    .option("--volume <n>", "Volume (0.0-1.0 or 0-100%); saved per-app with --app", parseFloat)
    .option("--voice [name]", "Voice id (provider-specific). Pass --voice with no value to list available voices.")
    .option("--rate <wpm>", "Words per minute (macOS only)", parseInt)
    .option("--wait", "Block until speech finishes")
    .option("--app <name>", "Caller identity for per-app mute")
    .option("--mute", "Mute (global or per-app with --app)")
    .option("--unmute", "Unmute (global or per-app with --app)")
    .option("--provider <name>", "TTS backend: 'macos' (default) or 'xai'", "macos")
    .option("--language <bcp47>", "Language hint (xai only; defaults to 'auto')")
    .option("--format <codec>", "Output codec for xAI: mp3 (default) or wav")
    .option("--file <path>", "Read text from a file instead of args")
    .option("--stream", "Force WebSocket streaming path (xai only; auto-engaged for >15k chars)")
    .action(async (messageParts: string[], opts: SayOptions) => {
        if (opts.mute) {
            await setMute(true, opts.app);
            const scope = opts.app ? `app "${opts.app}"` : "global";
            console.log(pc.yellow(`[say] ${scope} muted`));
            return;
        }

        if (opts.unmute) {
            await setMute(false, opts.app);
            const scope = opts.app ? `app "${opts.app}"` : "global";
            console.log(pc.green(`[say] ${scope} unmuted`));
            return;
        }

        // `--voice` with no value: list available voices and exit.
        if (opts.voice === true) {
            await printVoiceList(opts.provider);
            return;
        }

        const text = await resolveText(messageParts, opts.file);

        if (text == null) {
            await interactiveMode();
            return;
        }

        const provider: SayProvider = opts.provider ?? "macos";
        const voice = typeof opts.voice === "string" ? opts.voice : undefined;

        if (provider === "xai") {
            await speakViaXai(text, { ...opts, voice });
            return;
        }

        await speak(text, {
            volume: opts.volume,
            voice,
            rate: opts.rate,
            wait: opts.wait,
            app: opts.app,
        });
    });

async function resolveText(messageParts: string[], filePath?: string): Promise<string | null> {
    if (filePath) {
        const abs = resolve(filePath);

        if (!existsSync(abs)) {
            console.error(pc.red(`[say] file not found: ${abs}`));
            process.exit(1);
        }

        return readFileSync(abs, "utf8");
    }

    if (messageParts.length === 0) {
        return null;
    }

    return messageParts.join(" ");
}

async function speakViaXai(text: string, opts: SayOptions & { voice?: string }): Promise<void> {
    if (!process.env.X_AI_API_KEY) {
        console.error(pc.red("[say] X_AI_API_KEY is not set."));
        console.error(pc.dim(suggestCommand("tools say", { add: ["--provider", "macos"] })));
        process.exit(1);
    }

    const config = await getConfigForRead();
    const muted = isAppMuted(config, opts.app);

    if (muted) {
        process.stderr.write("[say] muted\n");
        return;
    }

    const provider = getTextToSpeechProvider("xai");
    const useStream = opts.stream || text.length > REST_TTS_LIMIT;

    const ttsOptions: TTSOptions = {
        voice: opts.voice ?? "eve",
        language: opts.language ?? "auto",
        format: opts.format ?? "mp3",
        stream: useStream,
    };

    let result: TTSResult;

    try {
        if (useStream) {
            if (!provider.synthesizeStream) {
                throw new Error("xAI provider missing synthesizeStream");
            }

            logger.debug(`[say] xai streaming (${text.length} chars)`);
            const stream = provider.synthesizeStream(text, ttsOptions);
            const chunks: Uint8Array[] = [];
            for await (const c of stream.audio) {
                chunks.push(c);
            }
            result = { audio: Buffer.concat(chunks), contentType: stream.contentType };
        } else {
            logger.debug(`[say] xai REST (${text.length} chars)`);
            result = await provider.synthesize(text, ttsOptions);
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(pc.red(`[say] xAI TTS failed: ${message}`));

        if (isVoiceNotFoundError(message)) {
            await printVoiceList("xai");
        }

        process.exit(1);
    }

    const ext = pickExtensionFromContentType(result.contentType, ttsOptions.format);
    const tmpFile = join(tmpdir(), `genesis-say-xai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    await Bun.write(tmpFile, result.audio);

    const rawVolume = opts.volume ?? (opts.app ? config.appVolume[opts.app] : undefined) ?? config.defaultVolume ?? 1;
    const volume = normalizeVolume(rawVolume);

    await playAudioFile(tmpFile, { volume, wait: opts.wait, cleanup: true });
}

function isAppMuted(config: SayConfig, app?: string): boolean {
    if (app && app in config.appMute) {
        return config.appMute[app];
    }

    return config.globalMute;
}

function pickExtensionFromContentType(contentType: string, requestedFormat?: TTSOptions["format"]): string {
    const ct = contentType.toLowerCase();

    if (ct.includes("mpeg") || ct.includes("mp3")) {
        return ".mp3";
    }

    if (ct.includes("wav")) {
        return ".wav";
    }

    if (ct.includes("aiff")) {
        return ".aiff";
    }

    return requestedFormat ? `.${requestedFormat}` : ".mp3";
}

function isVoiceNotFoundError(message: string): boolean {
    return /\b404\b/.test(message) || /voice .* not found/i.test(message);
}

async function printVoiceList(filterProvider?: SayProvider): Promise<void> {
    const providers: SayProvider[] = filterProvider ? [filterProvider] : ["macos", "xai"];

    for (const name of providers) {
        if (name === "xai" && !process.env.X_AI_API_KEY) {
            console.error(pc.dim(`\n[xai] X_AI_API_KEY not set — skipping`));
            continue;
        }

        console.log();
        console.log(pc.bold(pc.cyan(`Provider: ${name}`)));

        try {
            const provider = getProvider(name) as unknown as AITextToSpeechProvider;

            if (!provider.listVoices) {
                console.error(pc.dim(`  (no listVoices() implementation)`));
                continue;
            }

            const voices = await provider.listVoices();

            if (voices.length === 0) {
                console.error(pc.dim(`  (no voices reported)`));
                continue;
            }

            const rows = voices.map((v) => [v.id, v.name, v.locale ?? "", (v.description ?? "").slice(0, 60)]);
            console.log(formatTable(rows, ["ID", "Name", "Locale", "Description"]));
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(pc.red(`  failed to list voices: ${message}`));
        }
    }
}

async function main(): Promise<void> {
    try {
        await program.parseAsync(process.argv);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(message);
        process.exit(1);
    }
}

main();

// ============================================
// Interactive mode
// ============================================

async function interactiveMode(): Promise<void> {
    p.intro(pc.bgCyan(pc.black(" tools say ")));

    const config = await getConfigForRead();

    // Show current status
    showStatus(config);

    const action = await p.select({
        message: "What would you like to do?",
        options: [
            { value: "test", label: "Test voice", hint: "speak a sample" },
            { value: "mute", label: "Toggle mute", hint: config.globalMute ? "currently muted" : "currently unmuted" },
            { value: "app-mute", label: "App mute settings", hint: `${Object.keys(config.appMute).length} apps` },
            { value: "voice", label: "Set default voice" },
            { value: "volume", label: "Set default volume", hint: `current: ${config.defaultVolume}` },
            { value: "voices", label: "List available voices" },
        ],
    });

    if (p.isCancel(action)) {
        p.cancel("Cancelled");
        return;
    }

    switch (action) {
        case "test":
            await handleTest(config);
            break;
        case "mute":
            await handleToggleMute(config);
            break;
        case "app-mute":
            await handleAppMute(config);
            break;
        case "voice":
            await handleSetVoice(config);
            break;
        case "volume":
            await handleSetVolume(config);
            break;
        case "voices":
            await handleListVoices();
            break;
    }

    p.outro(pc.green("Done"));
}

function showStatus(config: SayConfig): void {
    const muteStatus = config.globalMute ? pc.red("MUTED") : pc.green("active");
    const voice = config.defaultVoice ?? "auto-detect";
    const volume = `${Math.round(config.defaultVolume * 100)}%`;

    console.log();
    console.log(`  Status: ${muteStatus}  |  Voice: ${pc.cyan(voice)}  |  Volume: ${pc.cyan(volume)}`);

    const mutedApps = Object.entries(config.appMute).filter(([, v]) => v);

    if (mutedApps.length > 0) {
        console.log(`  Muted apps: ${mutedApps.map(([k]) => pc.red(k)).join(", ")}`);
    }

    console.log();
}

async function handleTest(config: SayConfig): Promise<void> {
    const text = await p.text({
        message: "Text to speak:",
        placeholder: "Hello world",
        defaultValue: "Hello world",
    });

    if (p.isCancel(text)) {
        return;
    }

    const s = p.spinner();
    s.start("Speaking...");

    await speak(text, {
        volume: config.defaultVolume,
        voice: config.defaultVoice ?? undefined,
        wait: true,
    });

    s.stop("Done");
}

async function handleToggleMute(config: SayConfig): Promise<void> {
    const newState = !config.globalMute;
    await setMute(newState);

    if (newState) {
        p.log.warn("Global mute: ON");
    } else {
        p.log.success("Global mute: OFF");
    }
}

async function handleAppMute(config: SayConfig): Promise<void> {
    const apps = Object.entries(config.appMute);

    if (apps.length === 0) {
        p.log.info("No apps registered yet. Apps are auto-registered on first use via --app flag.");
        return;
    }

    const rows = apps.map(([name, muted]) => {
        const vol = config.appVolume[name];
        const volStr = vol != null ? `${Math.round(vol * 100)}%` : "default";
        return [name, muted ? pc.red("muted") : pc.green("active"), pc.cyan(volStr)];
    });
    console.log(formatTable(rows, ["App", "Status", "Volume"]));

    const appToToggle = await p.select({
        message: "Toggle mute for app:",
        options: apps.map(([name, muted]) => ({
            value: name,
            label: name,
            hint: muted ? "muted -> unmute" : "active -> mute",
        })),
    });

    if (p.isCancel(appToToggle)) {
        return;
    }

    const currentlyMuted = config.appMute[appToToggle];
    await setMute(!currentlyMuted, appToToggle);

    if (currentlyMuted) {
        p.log.success(`${appToToggle}: unmuted`);
    } else {
        p.log.warn(`${appToToggle}: muted`);
    }
}

async function handleSetVoice(config: SayConfig): Promise<void> {
    const voices = await listVoicesStructured();

    const options = [
        { value: "__auto__" as string, label: "Auto-detect", hint: "detect language automatically" },
        ...voices.map((v) => ({
            value: v.name,
            label: v.name,
            hint: `${v.locale} — ${v.sample.slice(0, 40)}`,
        })),
    ];

    const selected = await p.select({
        message: "Default voice:",
        options,
    });

    if (p.isCancel(selected)) {
        return;
    }

    config.defaultVoice = selected === "__auto__" ? null : selected;
    await setConfig(config);
    p.log.success(`Default voice: ${config.defaultVoice ?? "auto-detect"}`);
}

async function handleSetVolume(config: SayConfig): Promise<void> {
    const input = await p.text({
        message: "Default volume (0.0-1.0 or 0-100%):",
        placeholder: String(config.defaultVolume),
        defaultValue: String(config.defaultVolume),
        validate(value: string | undefined) {
            const n = parseFloat(value ?? "");

            if (Number.isNaN(n) || n < 0) {
                return "Must be a non-negative number (0.0-1.0 or 0-100)";
            }
        },
    });

    if (p.isCancel(input)) {
        return;
    }

    config.defaultVolume = normalizeVolume(parseFloat(input));
    await setConfig(config);
    p.log.success(`Default volume: ${config.defaultVolume}`);
}

async function handleListVoices(): Promise<void> {
    const voices = await listVoicesStructured();
    const rows = voices.map((v) => [v.lang, v.name, v.locale, v.sample.slice(0, 50)]);
    console.log(formatTable(rows, ["Lang", "Voice", "Locale", "Sample"]));
}
