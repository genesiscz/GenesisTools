import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { type Command, InvalidArgumentError } from "commander";
import { DEFAULT_CLASSIFY, devMonitorSources, formatEvent, runDevMonitor } from "../lib/dev-monitor";

function positiveNumber(value: string): number {
    const number = Number(value);

    if (!Number.isFinite(number) || number <= 0) {
        throw new InvalidArgumentError("a positive number");
    }

    return number;
}

interface MonitorFlags {
    json?: boolean;
    fromStart?: boolean;
    minStallMs: number;
    minSlowMainMs: number;
    minProfileMs: number;
    intervalMs: number;
    minDelayMs: number;
}

/** `tools hub dev …`: helpers for working on GenesisTools.app itself. */
export function registerDevCommands(program: Command): void {
    const dev = program
        .command("dev")
        .description("Helpers for developing GenesisTools.app (the hub, review and link faces)");

    dev.command("monitor")
        .description(
            "Stream the app's hangs, long stalls, layout loops, slow main-thread work, frame drops, errors, link-relay trouble and crash reports, one line per event. Run it under the Monitor tool while you change the app."
        )
        .option("--json", "one JSON object per event instead of a text line")
        .option("--from-start", "replay what the logs already hold, then follow them")
        .option(
            "--min-stall-ms <ms>",
            "leave out recovered stalls and frame drops shorter than this",
            positiveNumber,
            DEFAULT_CLASSIFY.minStallMs
        )
        .option(
            "--min-slow-main-ms <ms>",
            "leave out main-thread spans shorter than this",
            positiveNumber,
            DEFAULT_CLASSIFY.minSlowMainMs
        )
        .option(
            "--min-profile-ms <ms>",
            "report profiling lines (tools config profiling: CLI timers and whole command runs) at least this long",
            positiveNumber,
            DEFAULT_CLASSIFY.minProfileMs
        )
        .option("--interval-ms <ms>", "how often the files are read", positiveNumber, 500)
        .option(
            "--min-delay-ms <ms>",
            "print at most one batch per this many ms; events in between wait and go out together",
            positiveNumber,
            10_000
        )
        .action(async (flags: MonitorFlags) => {
            const sources = devMonitorSources();
            const start = `[${new Date().toTimeString().slice(0, 8)}] monitor watching ${sources.perfLog}, ${sources.profileLog()}, ${sources.relayLog}, ${sources.hangs}, ${sources.crashes}`;
            out.print(`${flags.json ? SafeJSON.stringify({ kind: "start", text: start }) : start}\n`);
            await withInterrupt((signal) =>
                runDevMonitor({
                    fromStart: flags.fromStart === true,
                    minStallMs: flags.minStallMs,
                    minSlowMainMs: flags.minSlowMainMs,
                    minProfileMs: flags.minProfileMs,
                    intervalMs: Math.max(100, flags.intervalMs),
                    minDelayMs: flags.minDelayMs,
                    signal,
                    // One write per batch, so the Monitor tool delivers it as one notification.
                    emit: (events) =>
                        out.print(
                            `${events.map((event) => (flags.json ? SafeJSON.stringify(event) : formatEvent(event))).join("\n")}\n`
                        ),
                })
            );
        });
}
