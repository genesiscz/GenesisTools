import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import {
    DEFAULT_WAKE_GATE,
    disableWakeGate,
    fixtureWakeEvents,
    readWakeGate,
    wakeBlockedByEnv,
    writeWakeGate,
} from "../lib/wake/wake";

export function registerWake(program: Command): void {
    const wake = program.command("wake").description("Wake-word gate for listen; off by default");
    wake.command("status")
        .description("Read the wake-word marker without starting the microphone")
        .action(() => {
            const gate = readWakeGate();
            out.result({
                ...gate,
                blocked: wakeBlockedByEnv(),
                mic: false,
                pid: gate.pid ?? null,
                startedAt: gate.startedAt,
            });
        });
    wake.command("enable")
        .description("Write the wake-word marker; first time requires a TTY")
        .option("--word <phrase>", "Wake phrase", "hey jev")
        .option("--stt [provider]", "STT used after trigger", "fixture")
        .option("--yes", "Allow non-TTY enable when a marker already exists")
        .action((options: { word: string; stt: string; yes?: boolean }) => {
            if (wakeBlockedByEnv()) {
                out.log.error("GENESIS_TOOLS_NO_WAKE=1 forbids enabling the wake-word gate.");
                process.exitCode = 1;
                return;
            }

            const existing = readWakeGate();
            if (!isInteractive() && !existing.enabled && !options.yes) {
                out.log.error("Wake enable needs a TTY the first time.");
                out.log.info(suggestCommand("tools jev wake enable", { add: ["--yes"] }));
                process.exitCode = 1;
                return;
            }

            writeWakeGate({
                ...DEFAULT_WAKE_GATE,
                ...existing,
                enabled: true,
                word: options.word,
                stt: options.stt,
            });
            out.result(readWakeGate());
        });
    wake.command("disable")
        .description("Turn the wake-word gate off")
        .action(() => {
            disableWakeGate();
            out.result(readWakeGate());
        });
    wake.command("test")
        .description("Replay fixture triggers; does not open a microphone")
        .action(async () => {
            const events = [];
            for await (const event of fixtureWakeEvents([{ atMs: 10, word: "hey jev" }], 1500)) {
                events.push(event);
            }
            out.result({ events, mic: false });
        });
}
