#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AI } from "@app/utils/ai/index.ts";
import { getModelsForTask } from "@app/utils/ai/ModelManager";
import { getProvidersForTask } from "@app/utils/ai/providers";
import type { AIProviderType } from "@app/utils/ai/types.ts";
import { suggestCommand } from "@app/utils/cli/executor";
import type { SayConfig } from "@app/utils/macos/tts.ts";
import { getConfigForRead, listVoicesStructured, normalizeVolume, setConfig, setMute } from "@app/utils/macos/tts.ts";
import { formatTable } from "@app/utils/table.ts";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

type SayProvider = "macos" | "xai" | "openai";

interface SayOptions {
    volume?: number;
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
    noStream?: boolean;
    model?: string;
}

const program = new Command()
    .name("say")
    .description("Text-to-speech with pluggable backends (macOS, xAI Grok, OpenAI)")
    .argument("[message...]", "Text to speak (omit to read --file or enter interactive mode)")
    .option("--volume <n>", "Volume (0.0-1.0 or 0-100%); saved per-app with --app", parseFloat)
    .option("--voice [name]", "Voice id (provider-specific). Pass --voice with no value to list available voices.")
    .option("--rate <wpm>", "Words per minute (macOS only)", parseInt)
    .option("--wait", "Block until speech finishes")
    .option("--app <name>", "Caller identity for per-app mute")
    .option("--mute", "Mute (global or per-app with --app)")
    .option("--unmute", "Unmute (global or per-app with --app)")
    .option("--provider <name>", "TTS backend: macos (default), xai, openai")
    .option("--language <bcp47>", "Language hint (xai only; defaults to 'auto')")
    .option("--format <codec>", "Output codec: mp3 (default) or wav")
    .option("--file <path>", "Read text from a file instead of args")
    .option("--stream", "Force streaming path")
    .option("--no-stream", "Force REST/non-streaming path")
    .option("--model <id>", "Provider-specific model (e.g. tts-1, gpt-4o-mini-tts for openai)")
    .action(async (messageParts: string[], opts: SayOptions) => {
        if (opts.mute) {
            await setMute(true, opts.app);
            console.log(pc.yellow(`[say] ${opts.app ? `app "${opts.app}"` : "global"} muted`));
            return;
        }

        if (opts.unmute) {
            await setMute(false, opts.app);
            console.log(pc.green(`[say] ${opts.app ? `app "${opts.app}"` : "global"} unmuted`));
            return;
        }

        if (opts.voice === true) {
            await printVoiceList(opts.provider);
            return;
        }

        const text = await resolveText(messageParts, opts.file);

        if (text == null) {
            await interactiveMode();
            return;
        }

        const muted = await isMutedForApp(opts.app);

        if (muted) {
            process.stderr.write("[say] muted\n");
            return;
        }

        const provider: SayProvider = opts.provider ?? "macos";

        if (provider !== "macos" && !envForProvider(provider)) {
            console.error(pc.red(`[say] env var for ${provider} is not set.`));
            console.error(pc.dim(suggestCommand("tools say", { add: ["--provider", "macos"] })));
            process.exit(1);
        }

        const volume = opts.volume != null ? normalizeVolume(opts.volume) : undefined;
        const stream = opts.stream === true ? true : opts.noStream === true ? false : undefined;

        try {
            await AI.speak(text, {
                provider,
                voice: typeof opts.voice === "string" ? opts.voice : undefined,
                language: opts.language,
                format: opts.format,
                rate: opts.rate,
                volume,
                stream,
                wait: opts.wait,
                model: opts.model,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(pc.red(`[say] TTS failed: ${message}`));

            if (isVoiceNotFoundError(message)) {
                await printVoiceList(provider);
            }

            process.exit(1);
        }
    });

// `tools say voices` subcommand
// Note: --provider lives on the root command (program.opts()), not here.
// Commander parses root options globally, so reading from opts would always be undefined.
program
    .command("voices")
    .description("List voices grouped by provider (use root --provider to filter)")
    .action(async () => {
        const rootOpts = program.opts<SayOptions>();
        await printVoiceList(rootOpts.provider);
    });

// `tools say models` subcommand
program
    .command("models")
    .description("List downloadable TTS/STT models grouped by provider")
    .option("--task <task>", "Filter by task: tts | transcribe", "tts")
    .action(async (opts: { task?: string }) => {
        const task = (opts.task ?? "tts") as "tts" | "transcribe";

        // Collect provider types: those that claim to support the task + "local-hf" always
        // (AILocalProvider supports transcribe but not tts at runtime — yet the registry has
        // downloadable TTS models registered under local-hf for future use.)
        const providerTypes = new Set<string>(getProvidersForTask(task).map((p) => p.type));
        providerTypes.add("local-hf");

        for (const provider of providerTypes) {
            const models = getModelsForTask(task, provider);

            if (models.length === 0) {
                continue;
            }

            console.log();
            console.log(pc.bold(pc.cyan(`[${provider}] ${task} models`)));
            const rows = models.map((m) => [m.id, m.name, m.description.slice(0, 80)]);
            console.log(formatTable(rows, ["ID", "Name", "Description"]));
        }

        console.log();
        console.log(pc.dim("Download with: tools ai models download <id>"));
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

function envForProvider(provider: SayProvider): boolean {
    if (provider === "xai") {
        return !!process.env.X_AI_API_KEY;
    }

    if (provider === "openai") {
        return !!process.env.OPENAI_API_KEY;
    }

    return true;
}

async function isMutedForApp(app: string | undefined): Promise<boolean> {
    const config = await getConfigForRead();

    if (app && app in config.appMute) {
        return config.appMute[app];
    }

    return config.globalMute;
}

function isVoiceNotFoundError(message: string): boolean {
    return /\b404\b/.test(message) || /voice .* not found/i.test(message);
}

async function printVoiceList(filter?: SayProvider): Promise<void> {
    const grouped = await AI.Synthesizer.create({ provider: "any" }).then((s) =>
        s.listVoices(filter ? { provider: filter as AIProviderType } : undefined)
    );

    for (const [providerType, voices] of Object.entries(grouped)) {
        const label =
            providerType === "macos"
                ? "macOS"
                : providerType === "xai"
                  ? "xAI"
                  : providerType === "openai"
                    ? "OpenAI"
                    : providerType;
        console.log();
        console.log(pc.bold(pc.cyan(`[${label}] (${voices.length} voices)`)));

        if (voices.length === 0) {
            console.error(pc.dim("  (no voices)"));
            continue;
        }

        const rows = voices.map((v) => [v.id, v.name, v.locale ?? "", (v.description ?? "").slice(0, 60)]);
        console.log(formatTable(rows, ["ID", "Name", "Locale", "Description"]));
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
    await AI.speak(String(text), { provider: "macos", volume: config.defaultVolume, wait: true });
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
