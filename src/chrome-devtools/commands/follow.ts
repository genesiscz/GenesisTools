import { out } from "@genesiscz/utils/logger";
import { inspectPidFile } from "@genesiscz/utils/process/pidfile";
import type { Command } from "commander";
import {
    channelHelpLines,
    monitorHints,
    parseChannels,
    RENDER_CHANNEL_HELP,
    RENDER_CHANNELS,
    type RenderChannel,
} from "../lib/channels.ts";
import { follow, missingCaptureChannels } from "../lib/follow.ts";
import { parseDuration } from "../lib/har-io.ts";
import { recorderPidPath } from "../lib/paths.ts";
import { artifactPath } from "../lib/platform.ts";
import { segmentStats } from "../lib/status.ts";
import { ignoreSigpipe, portOf, positiveNumber, suggest, withPort } from "./shared.ts";

const DEFAULT_RENDER: RenderChannel[] = ["nav", "doc", "redirect", "error"];

const EXAMPLE_OUT_LOG = artifactPath("api.log");

interface FollowOpts {
    port?: string;
    channels?: string;
    match?: string;
    last?: string;
    seconds?: string;
    out?: string;
}

export function registerFollow(program: Command): void {
    withPort(program.command("follow"))
        .description(
            "live view over the recorder's buffer — the sanctioned tail (rotation-aware; raw segment files must never be tailed). Prints Monitor-ready commands first."
        )
        .option("--channels <list>", `render channels (default ${DEFAULT_RENDER.join(",")})`)
        .option("--match <substr>", "URL filter — substring or /regex/flags")
        .option("--last <duration>", "replay the last 90s / 30m / 2h of the buffer first, then go live")
        .option("--seconds <n>", "stop after N seconds (default: run until killed)")
        .option("--out <file>", "also mirror lines into this file (what the printed Monitor commands tail)")
        .addHelpText(
            "after",
            `
Render channels (all derived from the buffer — picking them costs nothing).
'net' is accepted as shorthand for nav,doc,redirect,xhr,cookie (the network set):
${channelHelpLines(RENDER_CHANNEL_HELP).join("\n")}

Channels marked "needs the recorder's X channel" only show data when the
recorder captures X — follow tells you the exact restart command when not.

Examples:
  ${suggest(["follow", "--channels", "nav,redirect,cookie", "--match", "idp.example.com"])}
  ${suggest(["follow", "--channels", "error", "--last", "10m"])}
  ${suggest(["follow", "--channels", "xhr,error", "--out", EXAMPLE_OUT_LOG, "--seconds", "120"])}

Run long follows with run_in_background and --out, then arm a Monitor on the
printed command. Never pipe follow to head/tail.`
        )
        .action(async (opts: FollowOpts) => {
            const port = portOf(opts);
            // `net` is the recorder's CAPTURE channel; people naturally type it
            // here (status prints it), so accept it as the network render set.
            const raw = (opts.channels ?? "").replace(/\bnet\b/g, "nav,doc,redirect,xhr,cookie");
            const parsed = parseChannels(raw, RENDER_CHANNELS, DEFAULT_RENDER);

            if (parsed.invalid.length) {
                out.log.error(`unknown render channel(s): ${parsed.invalid.join(", ")}. Valid channels:`);
                out.log.error(channelHelpLines(RENDER_CHANNEL_HELP).join("\n"));
                process.exit(1);
            }

            const recorder = inspectPidFile(recorderPidPath(port));
            const stats = segmentStats(port);

            if (recorder.status !== "live" && stats.count === 0) {
                out.log.error(`nothing to follow on ${port}: no recorder is running and no buffer exists.`);
                out.log.info(
                    `  start one: ${suggest(["record", "--port", String(port), "--all-tabs"])}   (or just: ${suggest(["attach"])})`
                );
                process.exit(1);
            }

            if (recorder.status !== "live") {
                out.log.warn(
                    `recorder on ${port} is not running — following the leftover buffer only (no new events will arrive).`
                );
            }

            for (const missing of missingCaptureChannels(port, parsed.channels)) {
                out.log.warn(
                    `'${missing.channel}' needs the recorder's '${missing.needs}' capture channel, which is OFF. Restart it: ${suggest(["record", "--port", String(port), "--stop"])} && ${suggest(["record", "--port", String(port), "--all-tabs", "--channels", `+${missing.needs}`])}`
                );
            }

            let sinceMs: number | undefined;
            if (opts.last) {
                const ms = parseDuration(opts.last);
                if (ms === null) {
                    out.log.error(`--last takes 90s / 30m / 2h (bare number = minutes), got '${opts.last}'`);
                    process.exit(1);
                }

                sinceMs = Date.now() - ms;
            }

            ignoreSigpipe();

            // The mirror goes through one buffered FileSink (flushed per line),
            // not a per-line appendFileSync — a blocking write per rendered
            // event is the texture the recorder incident forbade.
            let mirror: ReturnType<ReturnType<typeof Bun.file>["writer"]> | undefined;
            if (opts.out) {
                await Bun.write(opts.out, "");
                mirror = Bun.file(opts.out).writer();
                out.log.info(
                    `pid ${process.pid} mirroring -> ${opts.out}    stop: kill ${process.pid}  # never pkill -f`
                );
                out.log.info("watch it (Monitor tool takes any of these verbatim):");
                for (const hint of monitorHints(opts.out, parsed.channels)) {
                    out.log.info(`  ${hint}`);
                }
            }

            await follow({
                port,
                channels: parsed.channels,
                match: opts.match,
                sinceMs,
                seconds: opts.seconds ? positiveNumber(opts.seconds, 0, "--seconds") : undefined,
                onLine: (line) => {
                    out.println(line);
                    if (mirror) {
                        mirror.write(`${line}\n`);
                        void mirror.flush();
                    }
                },
            });
            await mirror?.end();
            process.exit(0);
        });
}
