import { parseSttProvider } from "@genesiscz/utils/ai/stt/resolve";
import { parseLanguages, STT_PROVIDER_IDS } from "@genesiscz/utils/ai/stt/types";
import { voiceConfiguration } from "@genesiscz/utils/ai/voice/configuration";
import { createVoiceSession, type VoiceEvent } from "@genesiscz/utils/ai/voice/session";
import { runTool, suggestEnumFlag } from "@genesiscz/utils/cli";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { openVoiceCapsule, type VoiceCapsuleHandle } from "@genesiscz/utils/macos/voice-capsule";
import { Command } from "commander";
import { z } from "zod";

const fixtureSchema = z.array(
    z.object({
        kind: z.enum(["partial", "final", "speech_start", "speech_end", "error"]),
        text: z.string(),
        isFinal: z.boolean(),
        startedAtMs: z.number(),
        endedAtMs: z.number().optional(),
        confidence: z.number().optional(),
        error: z.string().optional(),
    })
);

function capsuleEvent(capsule: VoiceCapsuleHandle | null, event: VoiceEvent): void {
    if (event.kind === "level") {
        capsule?.send(event);
    } else if (event.kind === "partial" || event.kind === "final") {
        capsule?.send({ kind: event.kind, text: event.text });
    } else if (event.kind === "state") {
        capsule?.send({ kind: "state", state: event.state === "listening" ? "listening" : "idle" });
    } else if (event.kind === "error") {
        capsule?.send({ kind: "state", state: "error" });
    }
}

const program = new Command()
    .name("voice")
    .description("Reusable voice transcription, independent of Eve or UI control");
program
    .command("listen")
    .option("--provider [provider]", "STT provider: deepgram, openai, xai, elevenlabs, fixture")
    .option("--account <account>", "Configured account name or ID")
    .option("--model <model>", "Provider model")
    .option("--language <codes>", "Comma-separated language codes")
    .option("--input <source>", "mic, -, raw s16le PCM file, ffmpeg[:device], or fixture-only none", "mic")
    .option("--events-file <file>", "Fixture transcript events")
    .option("--max-seconds <seconds>", "Maximum recording duration", "300")
    .option("--capsule", "Show the existing optional native Capsule")
    .option("--stop-on-stdin", "Stop when the owning UI closes stdin; unavailable with PCM stdin input")
    .option("--json", "Emit typed JSONL events")
    .action(
        async (options: {
            provider?: string | boolean;
            account?: string;
            model?: string;
            language?: string;
            input: string;
            eventsFile?: string;
            maxSeconds: string;
            capsule?: boolean;
            stopOnStdin?: boolean;
            json?: boolean;
        }) => {
            if (typeof options.provider !== "string") {
                out.log.error(suggestEnumFlag("tools voice listen", "--provider", STT_PROVIDER_IDS));
                process.exitCode = 1;
                return;
            }

            if (options.stopOnStdin && options.input === "-") {
                throw new Error("PCM stdin and UI stop-on-stdin cannot share one input");
            }

            const maxDurationMs = Number(options.maxSeconds) * 1000;
            if (!Number.isFinite(maxDurationMs) || maxDurationMs < 100 || maxDurationMs > 3_600_000) {
                out.log.error("--max-seconds must be between 0.1 and 3600 seconds");
                process.exitCode = 1;
                return;
            }

            const provider = parseSttProvider(options.provider);
            const events = options.eventsFile
                ? fixtureSchema.parse(SafeJSON.parse(await Bun.file(options.eventsFile).text()))
                : undefined;
            await withInterrupt(
                async (signal) => {
                    const capsule = options.capsule ? openVoiceCapsule({ signal }) : null;
                    let stop: (() => void) | undefined;
                    const stopFromOwner = () => stop?.();
                    try {
                        const session = await createVoiceSession({
                            provider,
                            account: options.account,
                            model: options.model,
                            languages: parseLanguages(options.language),
                            input: options.input,
                            signal,
                            events,
                            maxDurationMs,
                            onEvent: (event) => {
                                capsuleEvent(capsule, event);
                                if (options.json) {
                                    out.print(`${SafeJSON.stringify(event)}\n`);
                                }
                            },
                        });
                        stop = session.stop;
                        if (options.stopOnStdin) {
                            process.stdin.on("end", stopFromOwner);
                            process.stdin.resume();
                            if (process.stdin.readableEnded) {
                                stop();
                            }
                        }

                        const text = await session.done;
                        out.result(
                            options.json
                                ? { kind: "complete", text, provider: session.provider, accountId: session.accountId }
                                : text
                        );
                    } finally {
                        process.stdin.removeListener("end", stopFromOwner);
                        if (options.stopOnStdin) {
                            process.stdin.pause();
                        }
                        await capsule?.close();
                    }
                },
                { handleTermination: true }
            );
        }
    );
program
    .command("configuration")
    .description(
        "Read live dictation providers, supported model defaults and enabled account labels without credentials"
    )
    .option("--json", "Emit metadata as JSON")
    .action(async () => {
        out.result(await voiceConfiguration());
    });
await runTool(program, { tool: "voice" });
