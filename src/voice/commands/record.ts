import { recordingControl, recordingFailure, recordPcmClip } from "@genesiscz/utils/ai/voice/record";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function registerVoiceRecording(program: Command): void {
    program
        .command("record")
        .description("Record a private local PCM clip without opening any speech provider")
        .requiredOption("--output <file>")
        .option("--input <source>", "mic or a raw s16le mono PCM fixture", "mic")
        .option("--mic-launcher <path>", "Explicit signed host launcher; required for microphone capture")
        .option("--max-seconds <seconds>", "Maximum recording duration, 0.1–30 seconds", Number, 30)
        .option("--wait-for-start", "Emit ready PID, then wait for start on stdin before capture")
        .option("--stop-on-stdin", "Finish recording when its owning UI closes stdin")
        .option("--json")
        .action(async (options) => {
            if (options.input === "-" && (options.waitForStart || options.stopOnStdin)) {
                throw new Error("PCM stdin and recording control cannot share the same input");
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
                        const clip = await recordPcmClip({
                            input: options.input,
                            output: options.output,
                            micLauncher: options.micLauncher,
                            maxDurationMs: options.maxSeconds * 1000,
                            signal,
                            stopSignal: control?.stopSignal,
                            onEvent: options.json ? (event) => out.print(`${SafeJSON.stringify(event)}\n`) : undefined,
                        });
                        out.result({ kind: "recorded", clip });
                    } catch (error) {
                        if (options.json) {
                            out.print(
                                `${SafeJSON.stringify(signal.aborted ? { kind: "error", code: "cancelled" } : recordingFailure(error))}\n`
                            );
                        }
                        throw error;
                    } finally {
                        await control?.close();
                    }
                },
                { handleTermination: true }
            );
        });
}
