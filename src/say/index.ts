#!/usr/bin/env bun

import type { SayConfig } from "@app/utils/macos/tts.ts";
import { getConfigForRead, listVoicesStructured, setConfig, setMute, speak } from "@app/utils/macos/tts.ts";
import { formatTable } from "@app/utils/table.ts";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

const program = new Command()
    .name("say")
    .description("Text-to-speech with volume control, auto language detection, and mute support")
    .argument("[message...]", "Text to speak")
    .option("--volume <n>", "Volume 0.0-1.0", parseFloat)
    .option("--voice <name>", "Override voice name")
    .option("--rate <wpm>", "Words per minute", parseInt)
    .option("--wait", "Block until speech finishes")
    .option("--app <name>", "Caller identity for per-app mute")
    .option("--mute", "Mute (global or per-app with --app)")
    .option("--unmute", "Unmute (global or per-app with --app)")
    .action(
        async (
            messageParts: string[],
            opts: {
                volume?: number;
                voice?: string;
                rate?: number;
                wait?: boolean;
                app?: string;
                mute?: boolean;
                unmute?: boolean;
            }
        ) => {
            // Handle mute/unmute commands
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

            // No message → interactive mode
            if (messageParts.length === 0) {
                await interactiveMode();
                return;
            }

            const message = messageParts.join(" ");

            await speak(message, {
                volume: opts.volume,
                voice: opts.voice,
                rate: opts.rate,
                wait: opts.wait,
                app: opts.app,
            });
        }
    );

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

    const rows = apps.map(([name, muted]) => [name, muted ? pc.red("muted") : pc.green("active")]);
    console.log(formatTable(rows, ["App", "Status"]));

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
        message: "Default volume (0.0 - 1.0):",
        placeholder: String(config.defaultVolume),
        defaultValue: String(config.defaultVolume),
        validate(value: string | undefined) {
            const n = parseFloat(value ?? "");

            if (Number.isNaN(n) || n < 0 || n > 1) {
                return "Must be a number between 0.0 and 1.0";
            }
        },
    });

    if (p.isCancel(input)) {
        return;
    }

    config.defaultVolume = parseFloat(input);
    await setConfig(config);
    p.log.success(`Default volume: ${config.defaultVolume}`);
}

async function handleListVoices(): Promise<void> {
    const voices = await listVoicesStructured();
    const rows = voices.map((v) => [v.lang, v.name, v.locale, v.sample.slice(0, 50)]);
    console.log(formatTable(rows, ["Lang", "Voice", "Locale", "Sample"]));
}
