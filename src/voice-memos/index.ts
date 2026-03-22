#!/usr/bin/env bun

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import logger from "@app/logger";
import { formatDateTime } from "@app/utils/date.ts";
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

const program = new Command();

program
    .name("voice-memos")
    .description("List, play, export, and transcribe macOS Voice Memos")
    .version("1.0.0")
    .showHelpAfterError(true);

program
    .command("list")
    .description("List all voice memos")
    .action(() => {
        listAction();
    });

program
    .command("play")
    .description("Play a voice memo")
    .argument("<id>", "Memo ID", parseInt)
    .action(async (id: number) => {
        await playAction(id);
    });

program
    .command("export")
    .description("Export a voice memo to a destination")
    .argument("<id>", "Memo ID", parseInt)
    .argument("[dest]", "Destination directory", ".")
    .action((id: number, dest: string) => {
        exportAction(id, dest);
    });

program
    .command("transcribe")
    .description("Transcribe a voice memo (tsrp first, then AI fallback)")
    .argument("[id]", "Memo ID (omit for --all)", (v) => parseInt(v, 10))
    .option("--all", "Transcribe all memos")
    .option("--force", "Re-transcribe even if tsrp transcript exists")
    .action((id: number | undefined, opts: { all?: boolean; force?: boolean }) => {
        transcribeAction(id, opts);
    });

program
    .command("search")
    .description("Search memos by title and transcript text")
    .argument("<query>", "Search query")
    .action((query: string) => {
        searchAction(query);
    });

// No subcommand → interactive mode
program.action(async () => {
    await interactiveMode();
});

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

function transcribeAction(id: number | undefined, opts: { all?: boolean; force?: boolean }): void {
    if (opts.all) {
        transcribeAll(opts.force ?? false);
        return;
    }

    if (id === undefined) {
        p.log.error("Provide a memo ID or use --all");
        process.exit(1);
    }

    transcribeOne(id);
}

function transcribeOne(id: number): void {
    const memo = resolveMemo(id);

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

    p.log.warning(`No embedded transcript for "${memo.title}".`);
    p.log.info("AI transcription not yet wired up — use the ask tool's TranscriptionManager when available.");
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
                transcribeOne(memo.id);
                break;
        }
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    try {
        await program.parseAsync(process.argv);
    } catch (err) {
        if (err instanceof VoiceMemosError) {
            p.log.warning(err.message);
            process.exit(1);
        }

        const message = err instanceof Error ? err.message : String(err);
        logger.error(`voice-memos error: ${message}`);
        p.log.error(message);
        process.exit(1);
    }
}

main().catch((err) => {
    logger.error(`Unexpected error: ${err}`);
    process.exit(1);
});
