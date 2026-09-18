import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { createEvaluator } from "@genesiscz/utils/ai/evaluation/service";
import {
    assertSttProvider,
    createLiveSttProvider,
    DEFAULT_WAKE_PHRASES,
    parseWakePhrases,
} from "@genesiscz/utils/ai/live-stt";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { z } from "zod";
import { parseSnapshotText } from "../lib/browser/snapshot";
import type { BrowserDriver } from "../lib/browser/types";
import { listenDaemonPlan } from "../lib/listen-daemon";
import { runListenPipeline, type WakeMode } from "../lib/listen-pipeline";

export function registerListen(program: Command): void {
    const listen = program
        .command("listen")
        .description("Realtime STT → Jev → browser/native actions")
        .option("--stt <provider>", "deepgram|grok-live|gpt-realtime|mock", "mock")
        .option("--account <name>", "tools ai account name")
        .option("--wake <phrases>", "comma-separated wake phrases", DEFAULT_WAKE_PHRASES.join(","))
        .option("--wake-mode <mode>", "off|contains|jev", "contains")
        .option("--pcm-in <path>", "s16le mono PCM file or -")
        .option("--goal <text>", "standing goal after wake")
        .option("--inputs <json>", "user-supplied form values")
        .option("--snapshot <file>", "fixture snapshot text for tests / offline")
        .option("--continuous", "Stay armed until stop/done")
        .option("--stt-fallback <provider>", "Reconnect target after one failed heartbeat")
        .action(
            async (options: {
                stt: string;
                account?: string;
                wake: string;
                wakeMode: string;
                pcmIn?: string;
                goal?: string;
                inputs?: string;
                snapshot?: string;
                continuous?: boolean;
            }) => {
                const wakeMode = z.enum(["off", "contains", "jev"]).parse(options.wakeMode) as WakeMode;
                const stt = assertSttProvider(options.stt);
                if (!options.pcmIn && stt !== "mock") {
                    throw new Error("Live listen needs PCM. Pass --pcm-in - or run on macOS with a capture helper.");
                }
                const provider = createLiveSttProvider(stt);
                const session = await provider.connect({ account: options.account, sampleRate: 16000 });
                const driver = await snapshotDriver(options.snapshot);
                const evaluate = await createEvaluator({ provider: selectedProvider(program) });
                const inputs = options.inputs ? SafeJSON.parse(options.inputs) : {};
                for await (const event of runListenPipeline({
                    events: session.events(),
                    evaluate,
                    driver,
                    wakeMode,
                    phrases: parseWakePhrases(options.wake),
                    goal: options.goal,
                    inputs,
                    continuous: options.continuous,
                })) {
                    out.result(event);
                }
                await session.close();
            }
        );

    const daemon = listen.command("daemon").description("Background listen via tools daemon (dry-run off Darwin)");
    daemon
        .command("install")
        .option("--stt <provider>", "STT provider", "mock")
        .option("--account <name>", "tools ai account")
        .option("--wake <phrases>", "wake phrases", DEFAULT_WAKE_PHRASES.join(","))
        .option("--wake-mode <mode>", "off|contains|jev", "contains")
        .option("--dry-run", "Print the plan without registering")
        .action((options: { stt: string; account?: string; wake: string; wakeMode: string; dryRun?: boolean }) => {
            out.result(listenDaemonPlan({ ...options, dryRun: options.dryRun ?? process.platform !== "darwin" }));
        });
    daemon.command("status").action(() => {
        out.result(
            listenDaemonPlan({ stt: "mock", wake: DEFAULT_WAKE_PHRASES.join(","), wakeMode: "contains", dryRun: true })
        );
    });
    daemon.command("stop").action(() => {
        out.result({ name: "jev-listen", stopped: true, dryRun: process.platform !== "darwin" });
    });
}

async function snapshotDriver(file?: string): Promise<BrowserDriver> {
    const text = file ? await Bun.file(file).text() : `button "Stop" uid=none1`;
    const observation = parseSnapshotText(text, "fixture:listen", "Fixture");
    return {
        async observe() {
            return observation;
        },
        async dispatch() {
            return { ok: true, overlay: false };
        },
    };
}
