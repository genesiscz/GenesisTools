import { STT_PROVIDER_IDS } from "@genesiscz/utils/ai/stt/types";
import { recordingControl } from "@genesiscz/utils/ai/voice/record";
import { pickEnumFlag } from "@genesiscz/utils/cli/enum-flag";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { z } from "zod";
import {
    discardVoiceNote,
    editVoiceNote,
    listVoiceNotes,
    readVoiceNote,
    recordVoiceNote,
    transcribeVoiceNote,
} from "./lib/widget/voice-notes";

export function registerWidgetVoiceNotes(widget: Command): void {
    const notes = widget.command("voice-notes").description("Private local recordings and editable transcripts");
    notes
        .command("list")
        .option("--json")
        .action(async (_options, command) => {
            out.result(await listVoiceNotes(command.optsWithGlobals().stateRoot));
        });
    notes
        .command("record")
        .option("--id <uuid>")
        .option("--input <source>", "mic or synthetic PCM file", "mic")
        .option("--mic-launcher <path>")
        .option("--wait-for-start")
        .option("--stop-on-stdin")
        .option("--json")
        .action(async (options, command) => {
            if (options.input === "-" && (options.waitForStart || options.stopOnStdin)) {
                throw new Error("PCM stdin cannot also control recording");
            }
            await withInterrupt(
                async (signal) => {
                    const control =
                        options.waitForStart || options.stopOnStdin
                            ? recordingControl({
                                  input: Bun.stdin.stream(),
                                  signal,
                                  waitForStart: options.waitForStart === true,
                              })
                            : undefined;
                    try {
                        if (options.waitForStart) {
                            out.print(`${SafeJSON.stringify({ kind: "ready", pid: process.pid })}\n`);
                        }
                        await control?.ready;
                        const note = await recordVoiceNote({
                            root: command.optsWithGlobals().stateRoot,
                            id: options.id,
                            input: options.input,
                            micLauncher: options.micLauncher,
                            signal,
                            stopSignal: control?.stopSignal,
                            onEvent: (event) => out.print(`${SafeJSON.stringify(event)}\n`),
                        });
                        out.result({ kind: "recorded", note });
                    } finally {
                        await control?.close();
                    }
                },
                { handleTermination: true }
            );
        });
    notes
        .command("show <id>")
        .requiredOption("--revision <revision>", "Current note revision", Number)
        .action(async (id: string, options, command) => {
            out.result(
                await readVoiceNote({
                    root: command.optsWithGlobals().stateRoot,
                    id,
                    expectedRevision: options.revision,
                })
            );
        });
    notes
        .command("edit <id>")
        .requiredOption("--revision <revision>", "Current note revision", Number)
        .requiredOption("--text-file <path>", "UTF-8 edited draft")
        .action(async (id: string, options, command) => {
            const file = Bun.file(options.textFile);
            if (file.size > 256_000) {
                throw new Error("Edited voice note is too large");
            }
            out.result(
                await editVoiceNote({
                    root: command.optsWithGlobals().stateRoot,
                    id,
                    expectedRevision: options.revision,
                    text: await file.text(),
                })
            );
        });
    notes
        .command("transcribe <id>")
        .requiredOption("--revision <revision>", "Current note revision", Number)
        .option("--provider [provider]", "Speech provider: deepgram|openai|xai|elevenlabs|fixture")
        .option("--account <account>")
        .option("--model <model>")
        .option("--language <language>")
        .option("--events-file <file>", "Synthetic fixture events only")
        .action(async (id: string, options, command) => {
            const provider = await pickEnumFlag({
                tool: "tools",
                subcommand: ["hub", "widget", "voice-notes", "transcribe", id],
                flag: "--provider",
                given: options.provider ?? true,
                values: STT_PROVIDER_IDS,
                fallback: "fixture",
                accepts: (value): value is (typeof STT_PROVIDER_IDS)[number] =>
                    STT_PROVIDER_IDS.some((entry) => entry === value),
            });
            if (!provider) {
                return;
            }
            const eventSchema = z.array(
                z.object({
                    kind: z.enum(["partial", "final", "speech_start", "speech_end", "error"]),
                    text: z.string(),
                    isFinal: z.boolean(),
                    startedAtMs: z.number(),
                    endedAtMs: z.number().optional(),
                    error: z.string().optional(),
                })
            );
            if (options.eventsFile && provider !== "fixture") {
                throw new Error("--events-file is only supported with --provider fixture");
            }
            const eventFile = options.eventsFile ? Bun.file(options.eventsFile) : undefined;
            if (eventFile && eventFile.size > 1_000_000) {
                throw new Error("Synthetic events exceed the supported size");
            }
            const events = eventFile ? eventSchema.parse(SafeJSON.parse(await eventFile.text())) : undefined;
            await withInterrupt(
                async (signal) => {
                    const note = await transcribeVoiceNote({
                        root: command.optsWithGlobals().stateRoot,
                        id,
                        expectedRevision: options.revision,
                        provider,
                        account: options.account,
                        model: options.model,
                        language: options.language,
                        events,
                        signal,
                        onEvent: (event) => out.print(`${SafeJSON.stringify(event)}\n`),
                    });
                    out.result({ kind: "transcribed", note });
                },
                { handleTermination: true }
            );
        });
    notes
        .command("discard <id>")
        .requiredOption("--revision <revision>", "Current note revision", Number)
        .action(async (id: string, options, command) => {
            out.result(
                await discardVoiceNote({
                    root: command.optsWithGlobals().stateRoot,
                    id,
                    expectedRevision: options.revision,
                })
            );
        });
}
