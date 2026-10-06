import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
    confirmLanguage as promptLanguage,
    selectAction,
    selectFormat,
    selectMemo,
    selectModel,
    selectOutput,
    selectProvider,
} from "@app/macos/lib/voice-memos/prompts.ts";
import * as p from "@clack/prompts";
import { AI } from "@genesiscz/utils/ai/index.ts";
import type { LanguageDetectionResult } from "@genesiscz/utils/ai/LanguageDetector.ts";
import { getAllProviders } from "@genesiscz/utils/ai/providers/index.ts";
import { formatOutput, type OutputFormat } from "@genesiscz/utils/ai/transcription-format.ts";
import type { AIProviderType, TranscriptionResult as AITranscriptionResult } from "@genesiscz/utils/ai/types.ts";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli/executor.ts";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { copyToClipboard } from "@genesiscz/utils/clipboard.ts";
import { isCloudProvider } from "@genesiscz/utils/config/ai.types";
import { formatDateTime } from "@genesiscz/utils/date.ts";
import { formatDuration } from "@genesiscz/utils/format.ts";
import { out } from "@genesiscz/utils/logger";
import type { TranscriptionResult as EmbeddedTranscriptionResult } from "@genesiscz/utils/macos/voice-memos.ts";
import {
    extractTranscript,
    getMemo,
    listMemos,
    searchMemos,
    type VoiceMemo,
    VoiceMemosError,
} from "@genesiscz/utils/macos/voice-memos.ts";
import { printSettingsSummary } from "@genesiscz/utils/prompts/clack/settings-summary.ts";
import { formatTable } from "@genesiscz/utils/table.ts";
import { Command } from "commander";
import pc from "picocolors";

const VALID_PROVIDERS: AIProviderType[] = ["cloud", "local-hf", "darwinkit", "openai", "groq", "openrouter", "xai"];
const TRANSCRIBE_PROVIDERS: AIProviderType[] = ["local-hf", "cloud", "openai", "groq", "openrouter", "xai"];

export function registerVoiceMemosCommand(program: Command): void {
    const vm = new Command("voice-memos");

    vm.description("List, play, export, and transcribe macOS Voice Memos").showHelpAfterError(true);

    vm.command("list")
        .description("List all voice memos")
        .action(async () => {
            await handleErrors(listAction);
        });

    vm.command("play")
        .description("Play a voice memo")
        .argument("<id>", "Memo ID", (v) => parseInt(v, 10))
        .action(async (id: number) => {
            await handleErrors(() => playAction(id));
        });

    vm.command("export")
        .description("Export a voice memo to a destination")
        .argument("<id>", "Memo ID", (v) => parseInt(v, 10))
        .argument("[dest]", "Destination directory", ".")
        .action(async (id: number, dest: string) => {
            await handleErrors(() => exportAction(id, dest));
        });

    vm.command("transcribe")
        .description("Transcribe a voice memo (tsrp first, then AI fallback)")
        .argument("[id]", "Memo ID (omit for interactive selection)", (v) => parseInt(v, 10))
        .option("--all", "Transcribe all memos")
        .option("--force", "Re-transcribe even if tsrp transcript exists")
        .option("--lang <language>", "Language hint (e.g. cs, en, de) — auto-detected if omitted")
        .option("--provider <provider>", "AI provider (local-hf, cloud, openai, groq, openrouter, darwinkit)")
        .option("--local", "Shorthand for --provider local-hf")
        .option("--model <model>", "Model name/id to use")
        .option("--format <format>", "Output format (text, json, srt, vtt)")
        .option("-o, --output <path>", "Write output to a file (or a per-memo directory with --all)")
        .option("-c, --clipboard", "Copy output to clipboard")
        .option("--sensitive", "Lower thresholds to capture quiet/background speakers")
        .action(async (id: number | undefined, opts: TranscribeOpts) => {
            await handleErrors(() => transcribeAction(id, opts));
        });

    vm.command("search")
        .description("Search memos by title and transcript text")
        .argument("<query>", "Search query")
        .action(async (query: string) => {
            await handleErrors(() => searchAction(query));
        });

    // No subcommand → interactive mode; without a terminal the picker would wait forever, so list instead
    vm.action(async () => {
        if (!isInteractive()) {
            await handleErrors(listAction);
            out.log.info(
                `The memo picker needs an interactive terminal. Use: ${toolCommand("macos voice-memos play")} <id>, ${toolCommand("macos voice-memos export")} <id> [dest], ${toolCommand("macos voice-memos transcribe")} <id>`
            );
            return;
        }

        await handleErrors(interactiveMode);
    });

    program.addCommand(vm);
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

async function handleErrors(fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
    } catch (err) {
        if (err instanceof VoiceMemosError) {
            p.log.warning(err.message);
            process.exit(1);
        }

        const message = err instanceof Error ? err.message : String(err);
        p.log.error(message);
        process.exit(1);
    }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatMemoDate(date: Date): string {
    return formatDateTime(date, { absolute: "datetime" });
}

function formatMemoRow(memo: VoiceMemo): string[] {
    return [
        String(memo.id),
        memo.title,
        formatMemoDate(memo.date),
        formatDuration(memo.duration, "s", "tiered"),
        memo.hasTranscript ? pc.green("Yes") : pc.dim("No"),
    ];
}

function printMemoTable(memos: VoiceMemo[]): void {
    if (memos.length === 0) {
        p.log.info("No voice memos found.");
        return;
    }

    const headers = ["#", "Title", "Date", "Duration", "Transcript"];
    const rows = memos.map(formatMemoRow);

    out.println(formatTable(rows, headers, { alignRight: [0, 3] }));
    out.println(pc.dim(`\n${memos.length} memo${memos.length === 1 ? "" : "s"}`));
}

function resolveMemo(id: number): VoiceMemo {
    const memo = getMemo(id);

    if (!memo) {
        throw new Error(`No memo found with ID ${id}`);
    }

    if (!existsSync(memo.path)) {
        throw new Error(`Audio file not found: ${memo.path}`);
    }

    return memo;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function listAction(): void {
    const memos = listMemos();
    printMemoTable(memos);
}

async function playAction(id: number): Promise<void> {
    const memo = resolveMemo(id);

    p.log.info(`Playing: ${pc.bold(memo.title)} (${formatDuration(memo.duration, "s", "tiered")})`);

    const proc = Bun.spawn(["afplay", memo.path], {
        stdio: ["inherit", "inherit", "inherit"],
    });

    await proc.exited;

    if (proc.exitCode !== 0) {
        throw new Error(`afplay exited with code ${proc.exitCode}`);
    }
}

function exportAction(id: number, dest: string): void {
    const memo = resolveMemo(id);

    if (!existsSync(dest)) {
        mkdirSync(dest, { recursive: true });
    }

    const datePrefix = memo.date.toISOString().slice(0, 10);
    const safeTitle = memo.title.replace(/[/\\?%*:|"<>]/g, "-");
    const ext = basename(memo.path).includes(".") ? `.${basename(memo.path).split(".").pop()}` : ".m4a";
    const destFile = join(dest, `${datePrefix}-${safeTitle}${ext}`);

    copyFileSync(memo.path, destFile);
    p.log.success(`Exported to ${pc.bold(destFile)}`);
}

// ---------------------------------------------------------------------------
// Transcribe
// ---------------------------------------------------------------------------

interface TranscribeOpts {
    all?: boolean;
    force?: boolean;
    lang?: string;
    provider?: string;
    local?: boolean;
    model?: string;
    format?: OutputFormat;
    output?: string;
    clipboard?: boolean;
    sensitive?: boolean;
}

async function ensureTranscribeProvider(opts: TranscribeOpts): Promise<string> {
    if (opts.local) {
        return "local-hf";
    }

    if (opts.provider) {
        return opts.provider;
    }

    const available: string[] = [];

    for (const provider of getAllProviders()) {
        if (!provider.supports("transcribe")) {
            continue;
        }

        if (await provider.isAvailable()) {
            available.push(provider.type);
        }
    }

    if (isInteractive()) {
        if (available.length === 0) {
            out.error(pc.red("No transcription providers are available."));
            out.error(pc.dim("Set one of: OPENAI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, X_AI_API_KEY"));
            process.exit(1);
        }

        const picked = await p.select({
            message: "Pick a transcription provider:",
            options: available.map((id) => ({ value: id, label: id })),
        });

        if (p.isCancel(picked)) {
            process.exit(1);
        }

        return picked as string;
    }

    const choices = available.length > 0 ? available.join("|") : "local-hf|cloud|openai|groq|openrouter|xai";
    out.error(pc.red("No --provider specified and not in an interactive terminal."));
    out.error(
        pc.dim(
            suggestCommand("tools macos voice-memos transcribe", {
                // The 'tools macos' wrapper passes argv as ["voice-memos", "transcribe", ...]
                // to the inner process — strip those so they don't double the path.
                subcommand: ["voice-memos", "transcribe"],
                add: ["--provider", `<${choices}>`],
            })
        )
    );
    process.exit(1);
}

async function transcribeAction(id: number | undefined, opts: TranscribeOpts): Promise<void> {
    // Validate --provider and --model early
    validateProviderOption(opts.provider);
    validateModelOption(opts.model, opts.local ? "local-hf" : opts.provider);

    if (opts.all && opts.clipboard) {
        throw new Error("--clipboard cannot be combined with --all; use --output <directory> or terminal output");
    }

    opts.provider = await ensureTranscribeProvider(opts);

    if (opts.all) {
        const resolved = await resolveTranscribeOptions(opts);
        await transcribeAll(resolved);
        return;
    }

    // If no ID provided, prompt for memo selection (TTY) or error (non-TTY)
    let resolvedId = id;

    if (resolvedId === undefined) {
        if (!process.stdout.isTTY) {
            p.log.error("Provide a memo ID or use --all (non-interactive mode)");
            process.exit(1);
        }

        const memos = listMemos();
        const selected = await selectMemo(memos);

        if (!selected) {
            return;
        }

        resolvedId = selected.id;
    }

    // Resolve all options — prompt for missing ones when TTY
    const resolved = await resolveTranscribeOptions(opts);

    await transcribeOne({
        id: resolvedId!,
        force: resolved.force,
        lang: resolved.lang,
        provider: resolved.provider,
        model: resolved.model,
        format: resolved.format,
        output: resolved.output,
        clipboard: resolved.clipboard,
        sensitive: resolved.sensitive,
    });
}

function validateProviderOption(provider: string | undefined): void {
    if (provider === undefined) {
        return;
    }

    if (!provider) {
        p.log.error(
            `Invalid --provider (empty). Choose from: ${TRANSCRIBE_PROVIDERS.join(", ")}\n` +
                `  All providers: ${VALID_PROVIDERS.join(", ")}`
        );
        process.exit(1);
    }

    if (!VALID_PROVIDERS.includes(provider as AIProviderType)) {
        p.log.error(
            `Unknown provider "${provider}". Choose from: ${TRANSCRIBE_PROVIDERS.join(", ")}\n` +
                `  All providers: ${VALID_PROVIDERS.join(", ")}`
        );
        process.exit(1);
    }
}

function validateModelOption(model: string | undefined, provider: string | undefined): void {
    if (model === undefined) {
        return;
    }

    if (!model) {
        const providerType = provider ?? "local-hf";
        const suggestions = isCloudProvider(providerType as AIProviderType)
            ? "whisper-large-v3-turbo, whisper-large-v3, whisper-1"
            : "onnx-community/whisper-large-v3-turbo, onnx-community/whisper-small, onnx-community/whisper-base, onnx-community/whisper-tiny";

        p.log.error(`Invalid --model (empty). Available for ${providerType}: ${suggestions}`);
        process.exit(1);
    }
}

export interface ResolvedTranscribeOpts {
    force?: boolean;
    lang?: string;
    provider?: string;
    model?: string;
    format?: OutputFormat;
    output?: string;
    clipboard?: boolean;
    sensitive?: boolean;
}

interface MemoTranscriber {
    transcribe: (
        filePath: string,
        opts: {
            language?: string;
            model?: string;
            onProgress: (info: { message: string }) => void;
            onSegment: (seg: { start: number; text: string }) => void;
            confirmLanguage?: (detected: LanguageDetectionResult) => Promise<string>;
            thresholds?: {
                noSpeechThreshold: number;
                logprobThreshold: number;
                compressionRatioThreshold: number;
            };
        }
    ) => Promise<AITranscriptionResult>;
    dispose: () => void;
}

export interface TranscriptDeliveryDeps {
    copy: (value: string) => Promise<void>;
    write: (filePath: string, value: string) => Promise<void>;
    print: (value?: string) => void;
}

const DEFAULT_DELIVERY_DEPS: TranscriptDeliveryDeps = {
    copy: async (value) => {
        await copyToClipboard(value, { label: "transcription" });
    },
    write: async (filePath, value) => {
        await Bun.write(filePath, value);
    },
    print: (value = "") => out.println(value),
};

export interface TranscribeOneDeps {
    resolveMemo: (id: number) => VoiceMemo;
    extractTranscript: (filePath: string) => EmbeddedTranscriptionResult | null;
    createTranscriber: (opts: { provider?: string; model?: string }) => Promise<MemoTranscriber>;
    deliver: typeof deliverMemoTranscript;
}

const DEFAULT_TRANSCRIBE_ONE_DEPS: TranscribeOneDeps = {
    resolveMemo,
    extractTranscript,
    createTranscriber: async (opts) => AI.Transcriber.create({ ...opts, persist: true }),
    deliver: deliverMemoTranscript,
};

export function embeddedTranscriptResult(transcript: EmbeddedTranscriptionResult): AITranscriptionResult {
    let previousEnd = 0;
    const segments = transcript.segments.map((segment, index) => {
        const start = segment.startTime ?? previousEnd;
        const nextStart = transcript.segments[index + 1]?.startTime;
        const end = Math.max(start, segment.endTime ?? nextStart ?? start + 2);
        previousEnd = end;
        return { text: segment.text, start, end };
    });

    return { text: transcript.text, segments };
}

export async function deliverMemoTranscript(
    args: {
        result: AITranscriptionResult;
        format?: OutputFormat;
        output?: string;
        clipboard?: boolean;
    },
    deps: TranscriptDeliveryDeps = DEFAULT_DELIVERY_DEPS
): Promise<{ formatted: string; outputPath: string | null }> {
    const format = args.format ?? "text";
    const formatted = formatOutput(args.result, format);

    if (args.clipboard) {
        await deps.copy(formatted);
    }

    const outputPath = args.output ? resolve(args.output) : null;
    if (outputPath) {
        await deps.write(outputPath, formatted);
    } else if (format === "text" && args.result.segments?.length) {
        deps.print();
        for (const segment of args.result.segments) {
            const start = formatDuration(segment.start * 1000, "ms", "tiered");
            deps.print(`${pc.dim(`[${start}]`)} ${segment.text.trim()}`);
        }
    } else {
        deps.print(formatted);
    }

    return { formatted, outputPath };
}

async function resolveTranscribeOptions(opts: TranscribeOpts): Promise<ResolvedTranscribeOpts> {
    const resolved: ResolvedTranscribeOpts = {
        force: opts.force,
        lang: opts.lang,
        sensitive: opts.sensitive,
    };

    const isTTY = !!process.stdout.isTTY;

    // Provider
    if (opts.local) {
        resolved.provider = "local-hf";
    } else if (opts.provider) {
        resolved.provider = opts.provider;
    } else if (isTTY) {
        resolved.provider = await selectProvider();
    }

    // Model
    if (opts.model) {
        resolved.model = opts.model;
    } else if (isTTY) {
        resolved.model = await selectModel((resolved.provider ?? "local-hf") as AIProviderType);
    }

    // Format — opts.format is only set when --format is explicitly passed (no Commander default)
    if (opts.format) {
        resolved.format = opts.format;
    } else if (isTTY) {
        resolved.format = await selectFormat();
    } else {
        resolved.format = "text";
    }

    // Output destination
    if (opts.output || opts.clipboard) {
        resolved.output = opts.output;
        resolved.clipboard = opts.clipboard;
    } else if (isTTY) {
        const outputChoice = await selectOutput();
        resolved.output = outputChoice.output;
        resolved.clipboard = outputChoice.clipboard;
    }

    // Show settings summary
    if (isTTY) {
        printSettingsSummary([
            {
                label: "Provider",
                value: resolved.provider ?? "auto",
                hint: opts.provider ? "from --provider" : undefined,
            },
            { label: "Model", value: resolved.model ?? "default", hint: opts.model ? "from --model" : undefined },
            { label: "Format", value: resolved.format ?? "text" },
            {
                label: "Output",
                value: resolved.clipboard ? "clipboard" : (resolved.output ?? "terminal"),
            },
            ...(resolved.lang ? [{ label: "Language", value: resolved.lang, hint: "from --lang" }] : []),
        ]);
    }

    return resolved;
}

export async function transcribeOne(
    opts: {
        id: number;
        force?: boolean;
        lang?: string;
        provider?: string;
        model?: string;
        format?: OutputFormat;
        output?: string;
        clipboard?: boolean;
        sensitive?: boolean;
    },
    deps: TranscribeOneDeps = DEFAULT_TRANSCRIBE_ONE_DEPS
): Promise<void> {
    const memo = deps.resolveMemo(opts.id);

    // Check for embedded transcript (tsrp) first — skip if --force
    if (!opts.force) {
        const transcript = deps.extractTranscript(memo.path);

        if (transcript) {
            p.log.info(`${pc.bold(memo.title)} — embedded transcript found`);
            const delivery = await deps.deliver({
                result: embeddedTranscriptResult(transcript),
                format: opts.format,
                output: opts.output,
                clipboard: opts.clipboard,
            });
            if (delivery.outputPath) {
                p.log.success(`Written to ${delivery.outputPath}`);
            }

            return;
        }
    }

    // AI transcription (retry once on corrupt cache)
    p.log.info(`Transcribing "${memo.title}" with AI...`);
    const s = p.spinner();
    s.start("Loading model...");

    const isTTY = !!process.stdout.isTTY;
    let confirmedLang: string | undefined = opts.lang;

    // After the first confirm we pin transcribeOpts.language so retries (Transcriber
    // wraps provider.transcribe in retry()) skip language detection entirely on the
    // provider side — bulletproof against any closure/scope quirks.
    const transcribeOpts: {
        language?: string;
        model?: string;
        onProgress: (info: { message: string }) => void;
        onSegment: (seg: { start: number; text: string }) => void;
        confirmLanguage?: (
            detected: import("@genesiscz/utils/ai/LanguageDetector.ts").LanguageDetectionResult
        ) => Promise<string>;
        thresholds?: {
            noSpeechThreshold: number;
            logprobThreshold: number;
            compressionRatioThreshold: number;
        };
    } = {
        language: opts.lang,
        model: opts.model,
        onProgress: (info: { message: string }) => {
            s.message(pc.dim(info.message));
        },
        onSegment: (seg: { start: number; text: string }) => {
            const ts = formatDuration(seg.start * 1000, "ms", "tiered");
            process.stderr.write(`${pc.dim(`  [${ts}] ${seg.text.trim()}`)}\n`);
        },
    };

    if (isTTY && !opts.lang) {
        transcribeOpts.confirmLanguage = async (detected) => {
            s.stop(`Detected: ${detected.language} (${Math.round(detected.confidence * 100)}%)`);
            const confirmed = await promptLanguage(detected);
            confirmedLang = confirmed;
            transcribeOpts.language = confirmed;
            transcribeOpts.confirmLanguage = undefined;
            s.start("Transcribing...");
            return confirmed;
        };
    }

    if (opts.sensitive) {
        transcribeOpts.thresholds = {
            noSpeechThreshold: 0.3,
            logprobThreshold: -0.5,
            compressionRatioThreshold: 2.4,
        };
    }

    let transcriber = await deps.createTranscriber({
        provider: opts.provider,
        model: opts.model,
    });

    let result: AITranscriptionResult;

    try {
        result = await transcriber.transcribe(memo.path, transcribeOpts);
    } catch (err) {
        transcriber.dispose();
        const msg = err instanceof Error ? err.message : String(err);

        if (msg.includes("cache is corrupted")) {
            s.stop("Model cache corrupted");
            p.log.warning("Re-downloading model...");
            s.start("Downloading model...");

            transcriber = await deps.createTranscriber({
                provider: opts.provider,
                model: opts.model,
            });

            // On retry: use the language already confirmed, skip re-detection/re-prompting
            const retryOpts = {
                ...transcribeOpts,
                language: confirmedLang,
                confirmLanguage: undefined,
            };

            result = await transcriber.transcribe(memo.path, retryOpts);
        } else {
            throw err;
        }
    }

    s.stop("Transcription complete");

    try {
        const delivery = await deps.deliver({
            result,
            format: opts.format,
            output: opts.output,
            clipboard: opts.clipboard,
        });
        if (delivery.outputPath) {
            p.log.success(`Written to ${delivery.outputPath}`);
        }
    } finally {
        transcriber.dispose();
    }
}

export async function transcribeAll(
    opts: ResolvedTranscribeOpts,
    deps: {
        listMemos: () => VoiceMemo[];
        exists: (filePath: string) => boolean;
        transcribe: typeof transcribeOne;
    } = { listMemos, exists: existsSync, transcribe: transcribeOne }
): Promise<void> {
    const memos = deps.listMemos();

    if (memos.length === 0) {
        p.log.info("No voice memos found.");
        return;
    }

    if (opts.clipboard) {
        throw new Error("--clipboard cannot be combined with --all; use --output <directory> or terminal output");
    }

    const outputDir = opts.output ? resolve(opts.output) : null;
    if (outputDir) {
        if (existsSync(outputDir) && !statSync(outputDir).isDirectory()) {
            throw new Error(`--output must be a directory with --all: ${outputDir}`);
        }

        mkdirSync(outputDir, { recursive: true });
    }

    let transcribed = 0;
    let skipped = 0;
    let failed = 0;
    const extension = opts.format === "text" || opts.format === undefined ? "txt" : opts.format;

    for (const memo of memos) {
        if (!deps.exists(memo.path)) {
            skipped++;
            continue;
        }

        try {
            await deps.transcribe({
                id: memo.id,
                ...opts,
                output: outputDir ? join(outputDir, `${memo.id}.${extension}`) : undefined,
            });
            transcribed++;
        } catch (err) {
            failed++;
            p.log.error(`${memo.title}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    out.println();
    p.log.info(
        `${pc.bold(String(transcribed))} transcribed, ${pc.bold(String(failed))} failed, ${pc.bold(String(skipped))} skipped (missing file)`
    );
    if (failed > 0) {
        throw new Error(`${failed} voice memo transcription${failed === 1 ? "" : "s"} failed`);
    }
}

function searchAction(query: string): void {
    const results = searchMemos(query);
    printMemoTable(results);
}

// ---------------------------------------------------------------------------
// Interactive mode (uses shared prompts — DRY)
// ---------------------------------------------------------------------------

async function interactiveMode(): Promise<void> {
    p.intro(pc.bgCyan(pc.black(" Voice Memos ")));

    while (true) {
        const memos = listMemos();

        if (memos.length === 0) {
            p.log.info("No voice memos found.");
            p.outro("Done");
            return;
        }

        const memo = await selectMemo(memos);

        if (!memo) {
            p.outro("Done");
            return;
        }

        const action = await selectAction(memo);

        if (!action) {
            continue;
        }

        switch (action) {
            case "play":
                await playAction(memo.id);
                break;
            case "export": {
                const dest = await p.text({
                    message: "Export to directory",
                    initialValue: ".",
                });

                if (p.isCancel(dest)) {
                    continue;
                }

                exportAction(memo.id, dest);
                break;
            }
            case "transcribe": {
                const opts: TranscribeOpts = {};
                opts.provider = await ensureTranscribeProvider(opts);
                const resolved = await resolveTranscribeOptions(opts);
                await transcribeOne({
                    id: memo.id,
                    provider: resolved.provider,
                    model: resolved.model,
                    format: resolved.format,
                });
                break;
            }
        }
    }
}
