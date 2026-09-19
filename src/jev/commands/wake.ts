import {
    matchWake,
    parseLanguages,
    parseSttProvider,
    parseWakePhrases,
    STT_PROVIDER_IDS,
} from "@genesiscz/utils/ai/stt";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { logger } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { failPlain, parseEnum, printResult } from "../lib/cli-output";
import {
    DEFAULT_WAKE_GATE,
    disableWakeGate,
    fixtureWakeEvents,
    readWakeGate,
    type WakeGate,
    wakeBlockedByEnv,
    writeWakeGate,
} from "../lib/wake/wake";

const { log } = logger.scoped("jev-wake");

const WAKE_MODES = ["contains", "jev"] as const;

const SAMPLE_UTTERANCES = [
    "hey jev press seven",
    "hey jeff, go back",
    "the jev report is late",
    "ok genesis close the tab",
    "press seven",
];

/**
 * The wake gate is a marker file `listen` reads; it never opens a microphone by itself. The
 * always-on daemon that would arm `listen` in the background is specified in
 * the wake-word spec and not shipped here.
 */
export function registerWake(program: Command): void {
    const wake = program.command("wake").description("Wake-word gate for listen; off by default, never opens a mic");
    wake.command("status")
        .description("Read the wake-word marker without starting the microphone")
        .action(() => {
            const gate = readWakeGate();
            printResult({
                ...gate,
                blocked: wakeBlockedByEnv(),
                mic: false,
                pid: gate.pid ?? null,
                startedAt: gate.startedAt,
                listen: listenCommandFor(gate),
            });
        });
    wake.command("enable")
        .description("Write the wake-word marker; first time requires a TTY")
        .option("--word <phrases>", "Comma-separated wake phrases", DEFAULT_WAKE_GATE.word)
        .option("--mode [mode]", "contains or jev", "contains")
        .option("--stt [provider]", `STT used after the trigger: ${STT_PROVIDER_IDS.join("|")}`, "fixture")
        .option("--account <id>", "tools ai account for the STT provider")
        .option("--language <codes>", "Comma-separated ISO 639-1 codes in priority order, e.g. cs,en")
        .option("--yes", "Allow non-TTY enable when a marker already exists")
        .action(
            (options: {
                word: string;
                mode?: string | boolean;
                stt?: string | boolean;
                account?: string;
                language?: string;
                yes?: boolean;
            }) => {
                try {
                    enable(options);
                } catch (error) {
                    failPlain(error, { command: "jev wake enable" });
                }
            }
        );
    wake.command("disable")
        .description("Turn the wake-word gate off")
        .action(() => {
            disableWakeGate();
            log.info("wake gate disabled");
            printResult(readWakeGate());
        });
    wake.command("test")
        .description("Run the deterministic matcher over sample utterances and replay fixture triggers; no microphone")
        .option("--word <phrases>", "Comma-separated wake phrases (default: the marker's)")
        .action(async (options: { word?: string }) => {
            const gate = readWakeGate();
            const phrases = parseWakePhrases(options.word ?? gate.word);
            const matches = SAMPLE_UTTERANCES.map((text) => ({ text, match: matchWake(text, phrases) }));
            const events = [];
            for await (const event of fixtureWakeEvents([{ atMs: 10, word: phrases[0] }], gate.cooldownMs)) {
                events.push(event);
            }

            for (const row of matches) {
                ui.info(
                    `${row.match ? "wake " : "     "} ${row.text}${row.match ? `  → "${row.match.remainder}"` : ""}`
                );
            }

            printResult({ phrases, matches, events, mic: false });
        });
}

function enable(options: {
    word: string;
    mode?: string | boolean;
    stt?: string | boolean;
    account?: string;
    language?: string;
    yes?: boolean;
}): void {
    if (wakeBlockedByEnv()) {
        ui.err("GENESIS_TOOLS_NO_WAKE=1 forbids enabling the wake-word gate.");
        process.exitCode = 1;
        return;
    }

    const mode = parseEnum(options.mode, WAKE_MODES, "--mode", "tools jev wake enable");
    if (!mode) {
        return;
    }

    const stt = parseSttProvider(typeof options.stt === "string" ? options.stt : "fixture");
    const phrases = parseWakePhrases(options.word);
    const existing = readWakeGate();
    if (!isInteractive() && !existing.enabled && !options.yes) {
        ui.err("Wake enable needs a TTY the first time.");
        ui.info(suggestCommand("tools jev wake enable", { add: ["--yes"] }));
        process.exitCode = 1;
        return;
    }

    const gate: WakeGate = {
        ...DEFAULT_WAKE_GATE,
        ...existing,
        enabled: true,
        word: phrases.join(","),
        mode: mode as WakeGate["mode"],
        stt,
        account: options.account ?? existing.account,
        languages: parseLanguages(options.language) ?? existing.languages,
    };
    writeWakeGate(gate);
    log.info({ phrases, mode, stt, account: gate.account, languages: gate.languages }, "wake gate enabled");
    ui.info(`Armed. Start listening with: ${listenCommandFor(gate)}`);
    printResult(readWakeGate());
}

function listenCommandFor(gate: WakeGate): string {
    const parts = ["tools jev listen", "--wake-mode", gate.mode ?? "contains", "--stt", gate.stt];
    if (gate.account) {
        parts.push("--account", gate.account);
    }

    if (gate.languages?.length) {
        parts.push("--language", gate.languages.join(","));
    }

    parts.push("--app", "<App>");
    return parts.join(" ");
}
