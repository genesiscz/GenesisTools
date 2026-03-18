import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { AI } from "@app/utils/ai/index.ts";
import { formatOutput, type OutputFormat } from "@app/utils/ai/transcription-format.ts";
import type { AIProviderType } from "@app/utils/ai/types.ts";
import { copyToClipboard } from "@app/utils/clipboard.ts";
import { formatDuration } from "@app/utils/format.ts";
import {
    extractTranscript,
    getMemo,
    listMemos,
    searchMemos,
    type VoiceMemo,
    VoiceMemosError,
} from "@app/utils/macos/voice-memos.ts";
import { formatTable } from "@app/utils/table.ts";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

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
        .argument("[id]", "Memo ID (omit for --all)", (v) => parseInt(v, 10))
        .option("--all", "Transcribe all memos")
        .option("--force", "Re-transcribe even if tsrp transcript exists")
        .option("--lang <language>", "Language hint (e.g. cs, en, de) — auto-detected if omitted")
        .option("--provider <provider>", "AI provider (local-hf, cloud, darwinkit)")
        .option("--local", "Shorthand for --provider local-hf")
        .option("--model <model>", "Model name/id to use")
        .option("--format <format>", "Output format (text, json, srt, vtt)", "text")
        .option("-o, --output <path>", "Write output to file")
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

    // No subcommand → interactive mode
    vm.action(async () => {
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
    return date.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
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

    console.log(formatTable(rows, headers, { alignRight: [0, 3] }));
    console.log(pc.dim(`\n${memos.length} memo${memos.length === 1 ? "" : "s"}`));
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

async function transcribeAction(id: number | undefined, opts: TranscribeOpts): Promise<void> {
    if (opts.all) {
        transcribeAll(opts.force ?? false);
        return;
    }

    if (id === undefined) {
        p.log.error("Provide a memo ID or use --all");
        process.exit(1);
    }

    await transcribeOne({
        id,
        force: opts.force,
        lang: opts.lang,
        provider: opts.local ? "local-hf" : opts.provider,
        model: opts.model,
        format: opts.format,
        output: opts.output,
        clipboard: opts.clipboard,
        sensitive: opts.sensitive,
    });
}

async function transcribeOne(opts: {
    id: number;
    force?: boolean;
    lang?: string;
    provider?: string;
    model?: string;
    format?: OutputFormat;
    output?: string;
    clipboard?: boolean;
    sensitive?: boolean;
}): Promise<void> {
    const memo = resolveMemo(opts.id);

    // Check for embedded transcript (tsrp) first — skip if --force
    if (!opts.force) {
        const transcript = extractTranscript(memo.path);

        if (transcript) {
            p.log.info(`${pc.bold(memo.title)} — embedded transcript found`);
            console.log();

            for (const segment of transcript.segments) {
                const timePrefix =
                    segment.startTime !== undefined
                        ? pc.dim(`[${formatDuration(segment.startTime * 1000, "ms", "tiered")}] `)
                        : "";
                console.log(`${timePrefix}${segment.text}`);
            }

            return;
        }
    }

    // AI transcription with full provider/model support (matching tools transcribe)
    p.log.info(`Transcribing "${memo.title}" with AI...`);
    const s = p.spinner();
    s.start("Loading model...");

    const transcriber = await AI.Transcriber.create({
        provider: opts.provider as AIProviderType | undefined,
        model: opts.model,
    });

    try {
        const result = await transcriber.transcribe(memo.path, {
            language: opts.lang,
            onProgress: (info) => {
                s.message(info.message);
            },
            onSegment: (seg) => {
                const ts = formatDuration(seg.start * 1000, "ms", "tiered");
                s.message(`[${ts}] ${seg.text.trim()}`);
            },
            // --sensitive lowers thresholds to capture quiet/background speakers
            ...(opts.sensitive
                ? {
                      thresholds: {
                          noSpeechThreshold: 0.3,
                          logprobThreshold: -0.5,
                          compressionRatioThreshold: 2.4,
                      },
                  }
                : {}),
        });

        s.stop("Transcription complete");

        // Format output using shared helpers
        const format = opts.format ?? "text";
        const formatted = formatOutput(result, format);

        // Output handling (matching tools transcribe pattern)
        if (opts.clipboard) {
            await copyToClipboard(formatted, { label: "transcription" });
        }

        if (opts.output) {
            const outputPath = resolve(opts.output);
            await Bun.write(outputPath, formatted);
            p.log.success(`Written to ${outputPath}`);
        }

        if (!opts.output) {
            // Default: print to stdout (with timestamps for text format)
            if (format === "text" && result.segments?.length) {
                console.log();

                for (const seg of result.segments) {
                    const start = formatDuration(seg.start * 1000, "ms", "tiered");
                    console.log(`${pc.dim(`[${start}]`)} ${seg.text.trim()}`);
                }
            } else {
                console.log(formatted);
            }
        }
    } finally {
        transcriber.dispose();
    }
}

function transcribeAll(force: boolean): void {
    const memos = listMemos();

    if (memos.length === 0) {
        p.log.info("No voice memos found.");
        return;
    }

    let transcribed = 0;
    let skipped = 0;
    let noTranscript = 0;

    for (const memo of memos) {
        if (!existsSync(memo.path)) {
            skipped++;
            continue;
        }

        if (memo.hasTranscript && !force) {
            transcribed++;
            continue;
        }

        const transcript = extractTranscript(memo.path);

        if (transcript) {
            transcribed++;
            p.log.success(`${memo.title}: ${transcript.text.slice(0, 80)}${transcript.text.length > 80 ? "..." : ""}`);
        } else {
            noTranscript++;
        }
    }

    console.log();
    p.log.info(
        `${pc.bold(String(transcribed))} transcribed, ${pc.bold(String(noTranscript))} without transcript, ${pc.bold(String(skipped))} skipped (missing file)`
    );
}

function searchAction(query: string): void {
    const results = searchMemos(query);
    printMemoTable(results);
}

// ---------------------------------------------------------------------------
// Interactive mode
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

        const memoChoice = await p.select({
            message: "Select a memo",
            options: [
                ...memos.map((m) => ({
                    value: m.id,
                    label: m.title,
                    hint: `${formatMemoDate(m.date)} · ${formatDuration(m.duration, "s", "tiered")}${m.hasTranscript ? " · has transcript" : ""}`,
                })),
                { value: -1, label: pc.dim("Exit") },
            ],
        });

        if (p.isCancel(memoChoice) || memoChoice === -1) {
            p.outro("Done");
            return;
        }

        const memo = memos.find((m) => m.id === memoChoice);

        if (!memo) {
            continue;
        }

        const action = await p.select({
            message: `${pc.bold(memo.title)} — choose action`,
            options: [
                { value: "play", label: "Play" },
                { value: "export", label: "Export" },
                { value: "transcribe", label: "Transcribe" },
                { value: "back", label: pc.dim("Back") },
            ],
        });

        if (p.isCancel(action) || action === "back") {
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
            case "transcribe":
                await transcribeOne({ id: memo.id });
                break;
        }
    }
}
