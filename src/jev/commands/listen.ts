import { NativeControlDriver } from "@app/control/lib/decision/native";
import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { createEvaluator } from "@genesiscz/utils/ai/evaluation/service";
import { type LiveTranscriptEvent, openLiveStt, parseSttProvider, STT_PROVIDER_IDS } from "@genesiscz/utils/ai/stt";
import { isInteractive, suggestCommand, suggestEnumFlag } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { z } from "zod";
import { createListenPipeline } from "../lib/listen/pipeline";
import type { PrefetchPayload } from "../lib/prefetch";
import { eventsAfterWake } from "../lib/wake/handoff";
import { readWakeGate } from "../lib/wake/wake";

export function registerListen(program: Command): void {
    program
        .command("listen")
        .description("Live STT into a typed Jev chooser over one app or browser tab")
        .option("--app <name>", "Native AX target")
        .option("--window-id <id>", "Pin one window")
        .option("--stt [provider]", "Live STT provider")
        .option("--account <id>", "tools ai account id")
        .option("--goal <text>", "Standing goal; otherwise the transcript is the intent")
        .option("--gate <n>", "Admission probability", "0.8")
        .option("--max-seconds <n>", "Session budget", "60")
        .option("--transcript <file>", "Replay JSONL instead of a microphone")
        .option("--surface [kind]", "ax, browser, or auto")
        .option("--from-wake", "Keep transcript events at or after the last wake phrase")
        .option("--dispatch-ahead", "Dispatch a prefetch hit without a second see")
        .option("--dry-run", "Never dispatch")
        .option("--force-act", "Allow dispatch from a pipe")
        .action(
            async (options: {
                app?: string;
                windowId?: string;
                stt?: string | boolean;
                account?: string;
                goal?: string;
                gate: string;
                maxSeconds: string;
                transcript?: string;
                surface?: string;
                fromWake?: boolean;
                dispatchAhead?: boolean;
                dryRun?: boolean;
                forceAct?: boolean;
            }) => {
                if (options.stt === undefined || options.stt === true) {
                    if (isInteractive()) {
                        options.stt = "fixture";
                    } else {
                        out.log.error(suggestEnumFlag("tools jev listen", "--stt", [...STT_PROVIDER_IDS]));
                        process.exitCode = 1;
                        return;
                    }
                }

                let provider: ReturnType<typeof parseSttProvider>;
                try {
                    provider = parseSttProvider(options.stt);
                } catch {
                    out.log.error(suggestEnumFlag("tools jev listen", "--stt", [...STT_PROVIDER_IDS]));
                    process.exitCode = 1;
                    return;
                }

                if (!isInteractive() && !options.transcript) {
                    out.log.error("Provide --transcript in non-interactive mode.");
                    out.log.info(suggestCommand("tools jev listen", { add: ["--transcript", "session.jsonl"] }));
                    process.exitCode = 1;
                    return;
                }

                const dryRun = options.dryRun === true || (!isInteractive() && options.forceAct !== true);
                const controller = new AbortController();
                const cancel = () => controller.abort();
                process.once("SIGINT", cancel);
                try {
                    let events: LiveTranscriptEvent[] = options.transcript
                        ? parseTranscript(await Bun.file(options.transcript).text())
                        : [];
                    if (options.fromWake) {
                        const word = readWakeGate().word;
                        const trigger = [...events]
                            .reverse()
                            .find((event) => event.text.toLowerCase().includes(word.toLowerCase()));
                        events = eventsAfterWake(events, trigger?.startedAtMs ?? 0);
                    }
                    const session = await openLiveStt({
                        provider,
                        accountId: options.account,
                        events,
                        signal: controller.signal,
                    });
                    const driver = options.app
                        ? new NativeControlDriver({
                              app: options.app,
                              windowId: options.windowId ? Number(options.windowId) : undefined,
                          })
                        : undefined;
                    const pipeline = createListenPipeline({
                        dryRun,
                        dispatchAhead: options.dispatchAhead === true,
                        gate: Number(options.gate),
                        signal: controller.signal,
                        evaluate: await createEvaluator({ provider: selectedProvider(program) }),
                        surface: {
                            see: async () => {
                                if (!driver) {
                                    throw new Error("listen without --app only supports --dry-run transcript replay.");
                                }

                                return driver.observe({ signal: controller.signal });
                            },
                            act: async (payload: PrefetchPayload, observation) => {
                                if (!driver || payload.action === "chrome") {
                                    return {
                                        ok: payload.action === "chrome",
                                        error: "chrome verb not dispatched in v1",
                                    };
                                }

                                return driver.act({
                                    observation,
                                    candidate: {
                                        id: "c0",
                                        element: payload.element,
                                        action: payload.action,
                                        label: "",
                                        role: "AXButton",
                                        ancestors: [],
                                    },
                                });
                            },
                        },
                    });
                    const decisions = [];
                    for await (const event of session.events()) {
                        decisions.push(await pipeline.decide(event));
                    }
                    await session.close();
                    out.result({ dryRun, provider, decisions });
                } finally {
                    process.off("SIGINT", cancel);
                }
            }
        );
}

function parseTranscript(text: string): LiveTranscriptEvent[] {
    return text
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => {
            const parsed = SafeJSON.parse(line);
            return z
                .object({
                    kind: z.enum(["partial", "final", "speech_start", "speech_end", "error"]),
                    text: z.string(),
                    isFinal: z.boolean().optional(),
                    startedAtMs: z.number().optional(),
                })
                .parse(parsed);
        })
        .map((event) => ({
            kind: event.kind,
            text: event.text,
            isFinal: event.isFinal ?? event.kind === "final",
            startedAtMs: event.startedAtMs ?? 0,
        }));
}
