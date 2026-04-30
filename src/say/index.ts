#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AI } from "@app/utils/ai/index.ts";
import { getModelsForTask } from "@app/utils/ai/ModelManager";
import { getProvidersForTask } from "@app/utils/ai/providers";
import type { AIProviderType } from "@app/utils/ai/types.ts";
import { isInteractive, suggestCommand } from "@app/utils/cli/executor";
import { parseVariadic } from "@app/utils/cli/variadic";
import {
    DEFAULT_APP_NAME,
    isSettableField,
    type SayAppConfig,
    SayConfigManager,
    type SayProvider,
    SETTABLE_FIELDS,
    type SettableField,
} from "@app/utils/macos/SayConfigManager.ts";
import { listVoicesStructured, normalizeVolume } from "@app/utils/macos/tts.ts";
import { formatTable } from "@app/utils/table.ts";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";
import { speakWithProfile } from "./lib/speak";

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
    save?: boolean;
    unset?: string[];
}

const program = new Command()
    .name("say")
    .description("Text-to-speech with pluggable backends (macOS, xAI Grok, OpenAI). Supports per-app config profiles.")
    .argument("[message...]", "Text to speak (omit to read --file or open the config TUI)")
    .option("--volume <n>", "Volume (0.0-1.0 or 0-100%)", parseFloat)
    .option("--voice [name]", "Voice id (provider-specific). Pass --voice with no value to list available voices.")
    .option(
        "--rate <n>",
        "Speed: 0..2 multiplier or 0..200%. 0=slowest, 1 (or 100)=default, 2 (or 200)=fastest. Provider speeds are matched to macOS native (~0.81×..1.86×) so the same --rate sounds identical on macOS and xAI.",
        parseFloat
    )
    .option("--wait", "Block until speech finishes")
    .option("--app <name>", "App profile to load (and required target for --save)")
    .option("--mute", "Mute (requires --save to persist)")
    .option("--unmute", "Unmute (requires --save to persist)")
    .option("--provider <name>", "TTS backend: macos, xai, openai (defaults to profile or macos)")
    .option("--language <bcp47>", "Language hint (xai only; defaults to 'auto')")
    .option("--format <codec>", "Output codec: mp3 or wav")
    .option("--file <path>", "Read text from a file instead of args")
    .option("--stream", "Force streaming path")
    .option("--no-stream", "Force REST/non-streaming path")
    .option("--model <id>", "Provider-specific model (e.g. tts-1, gpt-4o-mini-tts for openai)")
    .option("--save", "Persist explicitly-passed flags to the --app profile")
    .option(
        "--unset <fields>",
        "Comma-separated profile fields to ignore this run (or remove with --save)",
        parseVariadic,
        [] as string[]
    )
    .action(async (messageParts: string[], opts: SayOptions, cmd: Command) => {
        const mgr = new SayConfigManager();

        if (opts.mute && opts.unmute) {
            console.error(pc.red("[say] --mute and --unmute are mutually exclusive."));
            process.exit(1);
        }

        const unsetList = validateUnsetFields(opts.unset ?? []);

        if (opts.voice === true) {
            await printVoiceList(opts.provider);
            return;
        }

        if ((opts.mute || opts.unmute) && !opts.save) {
            console.error(pc.red("[say] --mute / --unmute now require --save to persist."));
            console.error(pc.dim("  e.g.: tools say --app claude --mute --save"));
            console.error(pc.dim("  or:   tools say config   (interactive)"));
            process.exit(1);
        }

        const text = await resolveText(messageParts, opts.file);

        const saveApp = opts.save ? await resolveSaveApp(opts.app, mgr) : undefined;
        const patch = opts.save ? buildPatchFromCLI(cmd, opts) : null;

        // Save-only invocation: --save without text. Persist and exit, do not speak,
        // do not enter interactive mode.
        if (opts.save && text == null) {
            await applySave({ mgr, app: saveApp as string, patch: patch as Partial<SayAppConfig>, unsetList });
            console.log(pc.green(`[say] saved profile "${saveApp}"`));
            return;
        }

        // No text and no save: open the unified config TUI (TTY only).
        if (text == null) {
            if (!isInteractive()) {
                console.error(pc.red("[say] no message provided."));
                console.error(pc.dim(suggestCommand("tools say", { add: ["<message>"] })));
                process.exit(1);
            }

            await configCommand(mgr);
            return;
        }

        // If --save is requesting a mute change, don't short-circuit on the
        // existing mute state — otherwise --unmute --save / --unset mute --save
        // can never be persisted from a currently-muted profile.
        const wantsMuteWrite = opts.save === true && (opts.unmute === true || unsetList.includes("mute"));

        if (!wantsMuteWrite && (await mgr.isMuted(opts.app))) {
            process.stderr.write("[say] muted\n");
            return;
        }

        const effective = await resolveEffective({ mgr, opts, unsetList });
        const provider: SayProvider = effective.provider ?? "macos";

        if (provider !== "macos" && !envForProvider(provider)) {
            console.error(pc.red(`[say] env var for ${provider} is not set.`));
            console.error(pc.dim(suggestCommand("tools say", { add: ["--provider", "macos"] })));
            process.exit(1);
        }

        const stream = opts.stream === true ? true : opts.noStream === true ? false : undefined;

        try {
            await AI.speak(text, {
                provider,
                voice: effective.voice ?? undefined,
                language: effective.language ?? undefined,
                format: effective.format ?? undefined,
                rate: effective.rate ?? undefined,
                volume: effective.volume ?? undefined,
                stream,
                wait: opts.wait,
                model: effective.model ?? undefined,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(pc.red(`[say] TTS failed: ${message}`));

            if (isVoiceNotFoundError(message)) {
                await printVoiceList(provider);
            }

            process.exit(1);
        }

        if (opts.save && saveApp && patch) {
            await applySave({ mgr, app: saveApp, patch, unsetList });
            console.log(pc.green(`[say] saved profile "${saveApp}"`));
        }
    });

program
    .command("voices")
    .description("List voices grouped by provider (use root --provider to filter)")
    .action(async () => {
        const rootOpts = program.opts<SayOptions>();
        await printVoiceList(rootOpts.provider);
    });

program
    .command("models")
    .description("List downloadable TTS/STT models grouped by provider")
    .option("--task <task>", "Filter by task: tts | transcribe", "tts")
    .action(async (opts: { task?: string }) => {
        const task = (opts.task ?? "tts") as "tts" | "transcribe";
        const providerTypes = new Set<string>(getProvidersForTask(task).map((pr) => pr.type));
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

program
    .command("config")
    .description("Manage per-app TTS profiles (add/edit/delete) interactively")
    .action(async () => {
        if (!isInteractive()) {
            console.error(pc.red("[say] config requires a TTY."));
            console.error(pc.dim(suggestCommand("tools say", { add: ["--app", "<name>", "--save"] })));
            process.exit(1);
        }

        await configCommand(new SayConfigManager());
    });

// ============================================
// Helpers
// ============================================

interface EffectiveSettings {
    voice?: string | null;
    volume?: number | null;
    provider?: SayProvider | null;
    rate?: number | null;
    model?: string | null;
    format?: "mp3" | "wav" | null;
    language?: string | null;
}

function validateUnsetFields(raw: string[]): SettableField[] {
    const out: SettableField[] = [];

    for (const u of raw) {
        if (!isSettableField(u)) {
            console.error(pc.red(`[say] --unset: unknown field "${u}"`));
            console.error(pc.dim(`  valid: ${SETTABLE_FIELDS.join(", ")}`));
            process.exit(1);
        }

        out.push(u);
    }

    return out;
}

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

function isVoiceNotFoundError(message: string): boolean {
    return /\b404\b/.test(message) || /voice .* not found/i.test(message);
}

async function resolveSaveApp(app: string | undefined, mgr: SayConfigManager): Promise<string> {
    if (app) {
        return app;
    }

    if (!isInteractive()) {
        console.error(pc.red("[say] --save requires --app <name> in non-interactive mode."));
        console.error(pc.dim(suggestCommand("tools say", { add: ["--app", "<name>"] })));
        process.exit(1);
    }

    const apps = await mgr.listApps();
    const NEW_APP = "__new__";

    const choice = await p.select({
        message: "Save to which app profile?",
        options: [
            ...apps.map((a) => ({ value: a.name, label: a.name })),
            { value: NEW_APP, label: pc.cyan("+ new app") },
        ],
    });

    if (p.isCancel(choice)) {
        p.cancel("Cancelled");
        process.exit(1);
    }

    if (choice !== NEW_APP) {
        return String(choice);
    }

    const name = await p.text({
        message: "New app name:",
        validate(v: string | undefined) {
            if (!v) {
                return "Name required";
            }

            if (v === DEFAULT_APP_NAME) {
                return `"${DEFAULT_APP_NAME}" is reserved`;
            }

            if (apps.some((a) => a.name === v)) {
                return `"${v}" already exists`;
            }
        },
    });

    if (p.isCancel(name)) {
        p.cancel("Cancelled");
        process.exit(1);
    }

    return String(name);
}

function isFromCLI(cmd: Command, key: string): boolean {
    return cmd.getOptionValueSource(key) === "cli";
}

function buildPatchFromCLI(cmd: Command, opts: SayOptions): Partial<SayAppConfig> {
    const patch: Partial<SayAppConfig> = {};

    if (isFromCLI(cmd, "voice") && typeof opts.voice === "string") {
        patch.voice = opts.voice;
    }

    if (isFromCLI(cmd, "volume") && opts.volume != null) {
        patch.volume = normalizeVolume(opts.volume);
    }

    if (isFromCLI(cmd, "provider") && opts.provider) {
        patch.provider = opts.provider;
    }

    if (isFromCLI(cmd, "rate") && opts.rate != null) {
        patch.rate = opts.rate;
    }

    if (isFromCLI(cmd, "model") && opts.model) {
        patch.model = opts.model;
    }

    if (isFromCLI(cmd, "format") && opts.format) {
        patch.format = opts.format;
    }

    if (isFromCLI(cmd, "language") && opts.language) {
        patch.language = opts.language;
    }

    if (isFromCLI(cmd, "mute") && opts.mute) {
        patch.mute = true;
    } else if (isFromCLI(cmd, "unmute") && opts.unmute) {
        patch.mute = false;
    }

    return patch;
}

async function applySave(args: {
    mgr: SayConfigManager;
    app: string;
    patch: Partial<SayAppConfig>;
    unsetList: SettableField[];
}): Promise<void> {
    const { mgr, app, patch, unsetList } = args;

    if (Object.keys(patch).length > 0) {
        await mgr.patchApp(app, patch);
    } else if (unsetList.length === 0) {
        // Edge: --save with no flags and no --unset → ensure the app exists.
        await mgr.patchApp(app, {});
    }

    if (unsetList.length > 0) {
        await mgr.unsetAppFields(app, unsetList);
    }
}

async function resolveEffective(args: {
    mgr: SayConfigManager;
    opts: SayOptions;
    unsetList: SettableField[];
}): Promise<EffectiveSettings> {
    const { mgr, opts, unsetList } = args;
    const profile = await mgr.resolveApp(opts.app);

    for (const f of unsetList) {
        delete profile[f];
    }

    return {
        voice: typeof opts.voice === "string" ? opts.voice : (profile.voice ?? null),
        volume: opts.volume != null ? normalizeVolume(opts.volume) : (profile.volume ?? null),
        provider: opts.provider ?? profile.provider ?? null,
        rate: opts.rate ?? profile.rate ?? null,
        model: opts.model ?? profile.model ?? null,
        format: opts.format ?? profile.format ?? null,
        language: opts.language ?? profile.language ?? null,
    };
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
// `tools say config` — unified app/profile manager
// ============================================

async function configCommand(mgr: SayConfigManager): Promise<void> {
    p.intro(pc.bgCyan(pc.black(" tools say config ")));

    while (true) {
        const apps = await mgr.listApps();
        const globalMute = await mgr.getGlobalMute();

        const action = await p.select({
            message: `What next? ${pc.dim(`(${apps.length} app${apps.length === 1 ? "" : "s"}, global mute: ${globalMute ? "ON" : "off"})`)}`,
            options: [
                { value: "speak", label: "Speak text (test)", hint: "speak with a chosen profile" },
                { value: "edit", label: "Edit an app profile", hint: "or create a new one" },
                { value: "list", label: "List apps with resolved settings" },
                { value: "delete", label: "Delete an app profile" },
                { value: "voices", label: "List available voices" },
                { value: "global-mute", label: `Toggle global mute (currently ${globalMute ? "ON" : "off"})` },
                { value: "exit", label: "Exit" },
            ],
        });

        if (p.isCancel(action) || action === "exit") {
            p.outro(pc.green("Done"));
            return;
        }

        switch (action) {
            case "speak":
                await speakActionTUI(mgr);
                break;
            case "edit":
                await pickAndEditAppTUI(mgr);
                break;
            case "list":
                await listAppsTUI(mgr);
                break;
            case "delete":
                await deleteAppTUI(mgr);
                break;
            case "voices":
                await printVoiceList();
                break;
            case "global-mute":
                await mgr.setGlobalMute(!globalMute);
                p.log.success(`Global mute: ${!globalMute ? "ON" : "off"}`);
                break;
        }
    }
}

const NEW_APP_SENTINEL = "__new__";

async function pickAndEditAppTUI(mgr: SayConfigManager): Promise<void> {
    const apps = await mgr.listApps();

    const target = await p.select({
        message: "Which profile?",
        options: [
            ...apps.map((a) => ({
                value: a.name,
                label: a.name + (a.name === DEFAULT_APP_NAME ? pc.dim(" (base)") : ""),
                hint: appPickerHint(a),
            })),
            { value: NEW_APP_SENTINEL, label: pc.cyan("+ new app") },
        ],
    });

    if (p.isCancel(target)) {
        return;
    }

    if (target === NEW_APP_SENTINEL) {
        const name = await promptNewAppName(apps);

        if (name == null) {
            return;
        }

        await mgr.upsertApp({ name });
        p.log.success(`Created profile "${name}"`);
        await editAppFields(mgr, name);
        return;
    }

    await editAppFields(mgr, String(target));
}

function appPickerHint(a: SayAppConfig): string {
    const bits: string[] = [];

    if (a.voice) {
        bits.push(`voice=${a.voice}`);
    }

    if (a.volume != null) {
        bits.push(`vol=${Math.round(a.volume * 100)}%`);
    }

    if (a.provider) {
        bits.push(a.provider);
    }

    if (a.mute) {
        bits.push("muted");
    }

    return bits.join(" · ");
}

async function promptNewAppName(apps: SayAppConfig[]): Promise<string | null> {
    const name = await p.text({
        message: "App name:",
        validate(v: string | undefined) {
            if (!v) {
                return "Name required";
            }

            if (v === DEFAULT_APP_NAME) {
                return `"${DEFAULT_APP_NAME}" is reserved`;
            }

            if (apps.some((a) => a.name === v)) {
                return `"${v}" already exists — pick "Edit" instead`;
            }
        },
    });

    if (p.isCancel(name)) {
        return null;
    }

    return String(name);
}

async function speakActionTUI(mgr: SayConfigManager): Promise<void> {
    const apps = await mgr.listApps();

    const appChoice = await p.select({
        message: "Speak with which profile?",
        options: apps.map((a) => ({
            value: a.name,
            label: a.name + (a.name === DEFAULT_APP_NAME ? pc.dim(" (base)") : ""),
            hint: appPickerHint(a),
        })),
    });

    if (p.isCancel(appChoice)) {
        return;
    }

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
    try {
        await speakWithProfile({
            text: String(text),
            app: String(appChoice) === DEFAULT_APP_NAME ? undefined : String(appChoice),
            wait: true,
        });
        s.stop("Done");
    } catch (err) {
        s.stop(pc.red("Failed"));
        p.log.error(err instanceof Error ? err.message : String(err));
    }
}

async function listAppsTUI(mgr: SayConfigManager): Promise<void> {
    const apps = await mgr.listApps();
    const rows: string[][] = [];

    for (const a of apps) {
        const eff = a.name === DEFAULT_APP_NAME ? a : await mgr.resolveApp(a.name);
        rows.push([
            a.name + (a.name === DEFAULT_APP_NAME ? pc.dim(" (base)") : ""),
            eff.voice ?? pc.dim("(auto)"),
            eff.volume != null ? `${Math.round(eff.volume * 100)}%` : pc.dim("(default)"),
            eff.provider ?? pc.dim("(macos)"),
            a.mute ? pc.red("muted") : pc.green("active"),
        ]);
    }

    console.log(formatTable(rows, ["App", "Voice", "Volume", "Provider", "Mute"]));
}

async function editAppFields(mgr: SayConfigManager, app: string): Promise<void> {
    while (true) {
        const profile = (await mgr.getApp(app)) ?? { name: app };

        const field = await p.select({
            message: `Edit "${app}" — pick a field`,
            options: [
                ...SETTABLE_FIELDS.map((f) => ({
                    value: f,
                    label: f,
                    hint: formatFieldValue(profile, f),
                })),
                { value: "__back__", label: pc.dim("← back") },
            ],
        });

        if (p.isCancel(field) || field === "__back__") {
            return;
        }

        await editSingleField(mgr, app, field as SettableField);
    }
}

function formatFieldValue(profile: SayAppConfig, field: SettableField): string {
    const v = profile[field];

    if (v === undefined || v === null) {
        return pc.dim("(inherit)");
    }

    if (field === "volume" && typeof v === "number") {
        return `${Math.round(v * 100)}%`;
    }

    return String(v);
}

async function editSingleField(mgr: SayConfigManager, app: string, field: SettableField): Promise<void> {
    if (field === "mute") {
        const profile = (await mgr.getApp(app)) ?? { name: app };
        const current = profile.mute === true;
        await mgr.setMute({ app, mute: !current });
        p.log.success(`${app}.mute = ${!current}`);
        return;
    }

    const action = await p.select({
        message: `${field}:`,
        options: [
            { value: "set", label: "Set value" },
            { value: "clear", label: "Clear (inherit from default)" },
            { value: "back", label: pc.dim("← back") },
        ],
    });

    if (p.isCancel(action) || action === "back") {
        return;
    }

    if (action === "clear") {
        await mgr.unsetAppFields(app, [field]);
        p.log.success(`${app}.${field} cleared`);
        return;
    }

    if (field === "provider") {
        const v = await p.select({
            message: "Provider:",
            options: [
                { value: "macos", label: "macos" },
                { value: "xai", label: "xai" },
                { value: "openai", label: "openai" },
            ],
        });

        if (p.isCancel(v)) {
            return;
        }

        await mgr.setProvider({ app, provider: v as SayProvider });
        p.log.success(`${app}.provider = ${v}`);
        return;
    }

    if (field === "format") {
        const v = await p.select({
            message: "Format:",
            options: [
                { value: "mp3", label: "mp3" },
                { value: "wav", label: "wav" },
            ],
        });

        if (p.isCancel(v)) {
            return;
        }

        await mgr.setFormat({ app, format: v as "mp3" | "wav" });
        p.log.success(`${app}.format = ${v}`);
        return;
    }

    if (field === "voice") {
        const voices = await listVoicesStructured();

        const v = await p.select({
            message: "Voice (macOS list shown — for xai/openai pass any provider voice id manually via --save):",
            options: voices.map((vc) => ({
                value: vc.name,
                label: vc.name,
                hint: vc.locale,
            })),
        });

        if (p.isCancel(v)) {
            return;
        }

        await mgr.setVoice({ app, voice: String(v) });
        p.log.success(`${app}.voice = ${v}`);
        return;
    }

    const input = await p.text({
        message: `${field}:`,
        validate(v: string | undefined) {
            if (!v) {
                return "Value required";
            }

            if (field === "volume" || field === "rate") {
                const n = Number.parseFloat(v);

                if (Number.isNaN(n) || n < 0) {
                    return "Must be a non-negative number";
                }
            }
        },
    });

    if (p.isCancel(input)) {
        return;
    }

    if (field === "volume") {
        await mgr.setVolume({ app, volume: normalizeVolume(Number.parseFloat(String(input))) });
    } else if (field === "rate") {
        await mgr.setRate({ app, rate: Number.parseFloat(String(input)) });
    } else if (field === "model") {
        await mgr.setModel({ app, model: String(input) });
    } else if (field === "language") {
        await mgr.setLanguage({ app, language: String(input) });
    }

    p.log.success(`${app}.${field} = ${input}`);
}

async function deleteAppTUI(mgr: SayConfigManager): Promise<void> {
    const apps = (await mgr.listApps()).filter((a) => a.name !== DEFAULT_APP_NAME);

    if (apps.length === 0) {
        p.log.info("No deletable apps (the default profile is non-removable).");
        return;
    }

    const target = await p.select({
        message: "Delete which profile?",
        options: apps.map((a) => ({ value: a.name, label: a.name })),
    });

    if (p.isCancel(target)) {
        return;
    }

    const confirmed = await p.confirm({
        message: `Really delete "${target}"? This cannot be undone.`,
        initialValue: false,
    });

    if (p.isCancel(confirmed) || !confirmed) {
        return;
    }

    await mgr.deleteApp(String(target));
    p.log.success(`Deleted "${target}"`);
}
