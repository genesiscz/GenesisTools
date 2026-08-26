import { existsSync } from "node:fs";
import { out } from "@genesiscz/utils/logger";
import { inspectPidFile, readSignalablePid } from "@genesiscz/utils/process/pidfile";
import type { Command } from "commander";
import {
    CAPTURE_CHANNEL_HELP,
    CAPTURE_CHANNELS,
    channelHelpLines,
    DEFAULT_CAPTURE_CHANNELS,
    parseChannels,
} from "../lib/channels.ts";
import { captureDir, recorderPidPath } from "../lib/paths.ts";
import { terminatePid } from "../lib/platform.ts";
import { recordScopeError, resolveRecordSeconds, runRecorder } from "../lib/recorder.ts";
import { ignoreSigpipe, portOf, suggest, withPort } from "./shared.ts";

interface RecordOpts {
    port?: string;
    match?: string;
    allTabs?: boolean;
    seconds?: string;
    channels?: string;
    stop?: boolean;
}

function registerRecordLike(program: Command, name: string, hidden: boolean): void {
    const cmd = withPort(program.command(name, { hidden }))
        .description(
            "the capture engine: one background recorder per port, HAR-grade metadata into a rolling 4h buffer. `har` dumps it retroactively, `follow` views it live."
        )
        .option("--match <substr>", "record only tabs whose URL contains this (the cheap scope)")
        .option("--all-tabs", "record every http(s) tab")
        .option(
            "--seconds <n>",
            "stop after N seconds (default 600 for a manual record; 0 = until the browser's CDP endpoint dies, max 24h)"
        )
        .option(
            "--channels <list>",
            `capture channels (default ${DEFAULT_CAPTURE_CHANNELS.join(",")}; prefix + adds to the default, e.g. +ws,body)`
        )
        .option("--stop", "stop the recorder for this port (the buffer stays dumpable)")
        .addHelpText(
            "after",
            `
Capture channels:
${channelHelpLines(CAPTURE_CHANNEL_HELP).join("\n")}

Examples:
  ${suggest([name, "--match", "idp.example.com"])}
  ${suggest([name, "--all-tabs", "--seconds", "0"])}
  ${suggest([name, "--match", "app.example.com", "--channels", "+ws,body"])}
  ${suggest([name, "--port", "9222", "--stop"])}

Do not pipe this command to head/tail — it prints its pid and keeps running.
The buffer segments under ${captureDir(9222).replace("9222", "<port>")} are INTERNAL; never tail them raw (rotation
breaks the fd silently). Use 'follow' for live viewing and 'har' for dumps.`
        );

    cmd.action(async (opts: RecordOpts) => {
        const port = portOf(opts);

        if (opts.stop) {
            const pidPath = recorderPidPath(port);
            if (!existsSync(pidPath)) {
                out.log.info(`no recorder running on ${port}`);
                process.exit(0);
            }

            const pid = readSignalablePid(pidPath);
            if (pid === null) {
                out.log.info(`no live recorder on ${port} (stale pidfile — 'cleanup --stale ${port}' clears it)`);
                process.exit(0);
            }

            const r = terminatePid(pid);
            out.log.info(
                r.exitCode === 0
                    ? `stopped recorder ${pid} on ${port} (buffer kept for har)`
                    : `stop ${pid} failed: ${r.stderr}`
            );
            process.exit(r.exitCode === 0 ? 0 : 1);
        }

        const scopeErr = recordScopeError({ match: opts.match, allTabs: opts.allTabs });
        if (scopeErr) {
            out.log.error(scopeErr);
            out.log.info(`  e.g. ${suggest([name, "--port", String(port), "--match", "idp.example.com"])}`);
            process.exit(1);
        }

        const parsed = parseChannels(opts.channels ?? "", CAPTURE_CHANNELS, DEFAULT_CAPTURE_CHANNELS);
        if (parsed.invalid.length) {
            out.log.error(`unknown capture channel(s): ${parsed.invalid.join(", ")}. Valid channels:`);
            out.log.error(channelHelpLines(CAPTURE_CHANNEL_HELP).join("\n"));
            process.exit(1);
        }

        const state = inspectPidFile(recorderPidPath(port));
        if (state.status === "live" && state.pid !== process.pid) {
            out.log.info(`recorder already up on ${port} (pid ${state.pid}) -> ${captureDir(port)}`);
            out.log.info(
                `  stop it first to change scope/channels: ${suggest([name, "--port", String(port), "--stop"])}`
            );
            process.exit(0);
        }

        ignoreSigpipe();
        try {
            await runRecorder({
                port,
                match: opts.match,
                allTabs: opts.allTabs,
                seconds: resolveRecordSeconds(opts.seconds),
                channels: parsed.channels,
            });
        } catch (err) {
            out.log.error(err instanceof Error ? err.message : String(err));
            out.log.info(`  see live ports: ${suggest(["attach"])}`);
            process.exit(1);
        }

        process.exit(0);
    });
}

export function registerRecord(program: Command): void {
    registerRecordLike(program, "record", false);
    // Hidden alias: the old skill called this verb `arm`.
    registerRecordLike(program, "arm", true);
}

export function registerWatchTombstone(program: Command): void {
    program
        .command("watch", { hidden: true })
        .allowUnknownOption(true)
        .allowExcessArguments(true)
        .description("removed — the engine/view split replaced it")
        .action(() => {
            out.log.error(`'watch' was split into an engine and a view:
  record   the capture engine (background, browser-wide, rolling buffer)
  follow   the live view (channels, Monitor hints) over that buffer
  har      the retroactive dump

  ${suggest(["record", "--match", "idp.example.com"])}
  ${suggest(["follow", "--channels", "nav,redirect,error", "--match", "idp.example.com"])}`);
            process.exit(1);
        });
}
