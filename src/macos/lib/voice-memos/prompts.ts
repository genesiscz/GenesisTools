/**
 * Shared interactive prompts for the voice-memos tool.
 * DRY: used by both interactive mode and the transcribe subcommand.
 */

import type { LanguageDetectionResult } from "@app/utils/ai/LanguageDetector.ts";
import { getModelsForTask, ModelManager } from "@app/utils/ai/ModelManager.ts";
import type { OutputFormat } from "@app/utils/ai/transcription-format.ts";
import type { AIProviderType } from "@app/utils/ai/types.ts";
import { isCloudProvider } from "@app/utils/config/ai.types";
import { formatDateTime } from "@app/utils/date.ts";
import { formatDuration } from "@app/utils/format.ts";
import type { VoiceMemo } from "@app/utils/macos/voice-memos.ts";
import { filePathCancelSymbol, filePathInput } from "@app/utils/prompts/clack/file-path.ts";
import * as p from "@clack/prompts";
import pc from "picocolors";

// ============================================
// Language name lookup
// ============================================

const LANG_NAMES: Record<string, string> = {
    af: "Afrikaans",
    am: "Amharic",
    ar: "Arabic",
    as: "Assamese",
    az: "Azerbaijani",
    ba: "Bashkir",
    be: "Belarusian",
    bg: "Bulgarian",
    bn: "Bengali",
    bo: "Tibetan",
    br: "Breton",
    bs: "Bosnian",
    ca: "Catalan",
    cs: "Czech",
    cy: "Welsh",
    da: "Danish",
    de: "German",
    el: "Greek",
    en: "English",
    es: "Spanish",
    et: "Estonian",
    eu: "Basque",
    fa: "Persian",
    fi: "Finnish",
    fo: "Faroese",
    fr: "French",
    gl: "Galician",
    gu: "Gujarati",
    ha: "Hausa",
    haw: "Hawaiian",
    he: "Hebrew",
    hi: "Hindi",
    hr: "Croatian",
    ht: "Haitian",
    hu: "Hungarian",
    hy: "Armenian",
    id: "Indonesian",
    is: "Icelandic",
    it: "Italian",
    ja: "Japanese",
    jw: "Javanese",
    ka: "Georgian",
    kk: "Kazakh",
    km: "Khmer",
    kn: "Kannada",
    ko: "Korean",
    la: "Latin",
    lb: "Luxembourgish",
    ln: "Lingala",
    lo: "Lao",
    lt: "Lithuanian",
    lv: "Latvian",
    mg: "Malagasy",
    mi: "Maori",
    mk: "Macedonian",
    ml: "Malayalam",
    mn: "Mongolian",
    mr: "Marathi",
    ms: "Malay",
    mt: "Maltese",
    my: "Myanmar",
    ne: "Nepali",
    nl: "Dutch",
    nn: "Nynorsk",
    no: "Norwegian",
    oc: "Occitan",
    pa: "Punjabi",
    pl: "Polish",
    ps: "Pashto",
    pt: "Portuguese",
    ro: "Romanian",
    ru: "Russian",
    sa: "Sanskrit",
    sd: "Sindhi",
    si: "Sinhala",
    sk: "Slovak",
    sl: "Slovenian",
    sn: "Shona",
    so: "Somali",
    sq: "Albanian",
    sr: "Serbian",
    su: "Sundanese",
    sv: "Swedish",
    sw: "Swahili",
    ta: "Tamil",
    te: "Telugu",
    tg: "Tajik",
    th: "Thai",
    tk: "Turkmen",
    tl: "Tagalog",
    tr: "Turkish",
    tt: "Tatar",
    uk: "Ukrainian",
    ur: "Urdu",
    uz: "Uzbek",
    vi: "Vietnamese",
    yi: "Yiddish",
    yo: "Yoruba",
    zh: "Chinese",
};

function langName(code: string): string {
    return LANG_NAMES[code] ?? code.toUpperCase();
}

// ============================================
// Memo Selection
// ============================================

function isIsoDateTitle(title: string): boolean {
    return /^\d{4}-\d{2}-\d{2}T/.test(title);
}

/**
 * Interactive memo selection prompt.
 * Returns the selected memo, or null if cancelled/exited.
 */
export async function selectMemo(memos: VoiceMemo[]): Promise<VoiceMemo | null> {
    if (memos.length === 0) {
        p.log.info("No voice memos found.");
        return null;
    }

    const memoChoice = await p.select({
        message: "Select a memo",
        options: [
            ...memos.map((m) => {
                const isoTitle = isIsoDateTitle(m.title);
                const dateStr = formatDateTime(m.date, {
                    relative: "two-days",
                    absolute: "datetime",
                    first: "relative",
                });
                const duration = formatDuration(m.duration, "s", "tiered");
                const transcript = m.hasTranscript ? " · has transcript" : "";

                const label = isoTitle ? dateStr : m.title;
                const hint = isoTitle ? `${duration}${transcript}` : `${dateStr} · ${duration}${transcript}`;

                return { value: m.id, label, hint };
            }),
            { value: -1, label: pc.dim("Exit") },
        ],
    });

    if (p.isCancel(memoChoice) || memoChoice === -1) {
        return null;
    }

    return memos.find((m) => m.id === memoChoice) ?? null;
}

// ============================================
// Action Selection
// ============================================

export type MemoAction = "play" | "export" | "transcribe" | "back";

/**
 * Interactive action selection for a memo.
 * Returns the selected action, or null if cancelled.
 */
export async function selectAction(memo: VoiceMemo): Promise<MemoAction | null> {
    const action = await p.select({
        message: `${pc.bold(memo.title)} — choose action`,
        options: [
            { value: "play" as const, label: "Play" },
            { value: "export" as const, label: "Export" },
            { value: "transcribe" as const, label: "Transcribe" },
            { value: "back" as const, label: pc.dim("Back") },
        ],
    });

    if (p.isCancel(action) || action === "back") {
        return null;
    }

    return action;
}

// ============================================
// Language Confirmation
// ============================================

/**
 * Prompt user to confirm or change the detected language.
 * Shows top-k alternatives with probabilities.
 * Returns the confirmed language code.
 */
export async function confirmLanguage(detected: LanguageDetectionResult): Promise<string> {
    const options: Array<{ value: string; label: string; hint?: string }> = [];

    if (detected.alternatives && detected.alternatives.length > 0) {
        for (const alt of detected.alternatives) {
            const pct = Math.round(alt.confidence * 100);
            options.push({
                value: alt.language,
                label: `${alt.language} — ${langName(alt.language)}`,
                hint: `${pct}%`,
            });
        }
    } else {
        const pct = Math.round(detected.confidence * 100);
        options.push({
            value: detected.language,
            label: `${detected.language} — ${langName(detected.language)}`,
            hint: `${pct}% via ${detected.driver}`,
        });
    }

    options.push({ value: "__other__", label: pc.dim("Other...") });

    const choice = await p.select({
        message: "Detected language — confirm or change",
        options,
    });

    if (p.isCancel(choice)) {
        return detected.language;
    }

    if (choice === "__other__") {
        const custom = await p.text({
            message: "Enter ISO language code (e.g. cs, en, de)",
            placeholder: "cs",
            validate: (val) => {
                if (!val || !/^[a-z]{2,3}$/i.test(val)) {
                    return "Enter a valid ISO language code (2-3 letters, e.g. cs, en, deu)";
                }

                return undefined;
            },
        });

        if (p.isCancel(custom)) {
            return detected.language;
        }

        return custom;
    }

    return choice;
}

// ============================================
// Transcription Settings Prompts
// ============================================

/**
 * Prompt for transcription provider.
 * Only shows providers that support transcription.
 */
export async function selectProvider(): Promise<AIProviderType> {
    const { getAllProviders } = await import("@app/utils/ai/providers/index.ts");
    const providers = getAllProviders();
    const available: Array<{ value: AIProviderType; label: string; hint: string }> = [];

    for (const prov of providers) {
        if (!prov.supports("transcribe")) {
            continue;
        }

        const isAvail = await prov.isAvailable();
        available.push({
            value: prov.type,
            label: providerLabel(prov.type),
            hint: isAvail ? "available" : "not available",
        });
    }

    if (available.length === 0) {
        p.log.error("No transcription providers available");
        process.exit(1);
    }

    const choice = await p.select({
        message: "Transcription provider",
        options: available,
    });

    if (p.isCancel(choice)) {
        p.cancel("Cancelled");
        process.exit(0);
    }

    return choice;
}

function providerLabel(type: AIProviderType): string {
    switch (type) {
        case "local-hf":
            return "Local (HuggingFace Whisper)";
        case "cloud":
            return "Cloud (auto-select)";
        case "openai":
            return "OpenAI";
        case "groq":
            return "Groq";
        case "openrouter":
            return "OpenRouter";
        case "darwinkit":
            return "DarwinKit (macOS native)";
        default:
            return type;
    }
}

/**
 * Prompt for model selection based on provider.
 */
export async function selectModel(provider: AIProviderType): Promise<string | undefined> {
    const knownModels = getModelsForTask("transcribe", provider);

    if (knownModels.length === 0) {
        if (isCloudProvider(provider)) {
            p.log.warning("No cloud API keys found. Set GROQ_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_KEY.");
        }

        return undefined;
    }

    // Resolve cache so we can show download status for local models
    const mgr = new ModelManager();

    if (provider === "local-hf") {
        await mgr.resolveTransformersCache();
    }

    const models = knownModels.map((m) => {
        let hint = m.description;

        if (provider === "local-hf") {
            const cached = mgr.isDownloaded(m.id);
            const status = cached ? pc.green("downloaded") : pc.dim("not downloaded");
            hint = `${m.description} · ${status}`;
        }

        return { value: m.id, label: m.name, hint };
    });

    if (models.length <= 1) {
        return models[0]?.value;
    }

    const choice = await p.select({
        message: "Model",
        options: models,
    });

    if (p.isCancel(choice)) {
        p.cancel("Cancelled");
        process.exit(0);
    }

    return choice;
}

/**
 * Prompt for output format.
 */
export async function selectFormat(): Promise<OutputFormat> {
    const choice = await p.select({
        message: "Output format",
        options: [
            { value: "text" as const, label: "Text", hint: "plain text with timestamps" },
            { value: "srt" as const, label: "SRT", hint: "SubRip subtitle format" },
            { value: "vtt" as const, label: "VTT", hint: "WebVTT subtitle format" },
            { value: "json" as const, label: "JSON", hint: "structured with segments" },
        ],
    });

    if (p.isCancel(choice)) {
        p.cancel("Cancelled");
        process.exit(0);
    }

    return choice;
}

/**
 * Prompt for output destination.
 */
export async function selectOutput(): Promise<{ output?: string; clipboard?: boolean }> {
    const choice = await p.select({
        message: "Output destination",
        options: [
            { value: "stdout" as const, label: "Print to terminal" },
            { value: "clipboard" as const, label: "Copy to clipboard" },
            { value: "file" as const, label: "Write to file" },
        ],
    });

    if (p.isCancel(choice)) {
        p.cancel("Cancelled");
        process.exit(0);
    }

    switch (choice) {
        case "clipboard":
            return { clipboard: true };
        case "file": {
            const filePath = await filePathInput({
                message: "Output file path",
            });

            if (filePath === filePathCancelSymbol) {
                p.cancel("Cancelled");
                process.exit(0);
            }

            return { output: filePath as string };
        }
        default:
            return {};
    }
}
