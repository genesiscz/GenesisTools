import { basename, dirname, resolve } from "node:path";
import { isInteractive, parseNonNegativeInt } from "@genesiscz/utils/cli";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { formatBytes } from "@genesiscz/utils/format";
import { findLogPlaylists, type HarLog, harStreamCandidates, readHar } from "@genesiscz/utils/hls/har";
import { downloadFile, partFileFor } from "@genesiscz/utils/http/download-file";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import type { Command } from "commander";
import { captureFromBrowser } from "./capture";
import { downloadStream, partsDirFor, readState, type StreamProgress } from "./download";
import { findProviderEvents, type ProviderEvent, providerById } from "./providers";
import { awaitEventState, describeEvent, recordingOutputName } from "./recording";
import { listCandidates, resolveSource, type StreamSource } from "./source";

const PROGRESS_THROTTLE_MS = 200;

interface DownloadFlags {
    out?: string;
    quality: string;
    stream?: string;
    header: string[];
    jobs: string;
    idleTimeout: string;
    backfill: boolean;
    stitchOnly?: boolean;
    list?: boolean;
    json?: boolean;
    chromeCdp?: string;
    chromeCdpPort?: string;
    chromeCdpWait: string;
    waitRecording?: boolean | string;
    fromStream?: boolean;
}

/** How long `--wait-recording` without a value waits for a broadcast to end and its recording to appear. */
const DEFAULT_RECORDING_WAIT_MINUTES = 240;

function slugify(text: string): string {
    return text
        .replace(/^https?:\/\//i, "")
        .replace(/[^a-z0-9]+/gi, "-")
        .replace(/^-+|-+$/g, "");
}

/**
 * The page and the playlist's folder, so two streams of one page get two names and a rerun finds its parts folder:
 * `https://example.com/watch/2` with `/live/abc123/master.m3u8` becomes `example-com-watch-2-abc123.mp4`.
 */
export function defaultOutputName(source: StreamSource): string {
    const folder = basename(dirname(new URL(source.playlistUrl).pathname));
    const parts = [source.page ? slugify(source.page).slice(-60) : "", slugify(folder).slice(-40)].filter(Boolean);
    return `${parts.join("-") || "stream"}.mp4`;
}

function describeProgress(progress: StreamProgress): string {
    const newest = progress.newestSequence === null ? "" : `, newest #${progress.newestSequence}`;

    switch (progress.phase) {
        case "probing":
            return "Looking for the oldest segment the CDN still keeps";
        case "stitching":
            return "Stitching the segments";
        default: {
            const state = progress.phase === "waiting" ? "live, waiting for new segments" : progress.phase;
            return `${progress.downloaded} segments on disk, ${progress.queued} queued, ${progress.gone} gone, ${formatBytes(progress.bytes)} this run${newest} (${state})`;
        }
    }
}

function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
}

export function registerStreamCommands(program: Command): void {
    const stream = program.command("stream").description("Download HLS streams, live or recorded");

    stream
        .command("download [source]")
        .description(
            "Download a stream from a HAR file, a playlist URL, or a page in your browser (--chrome-cdp). When the HAR shows a known player (StreamYard), the platform's own full recording is downloaded once the broadcast has ended; a live HLS stream is followed from its oldest available segment until it ends, then stitched. Run it again with the same --out to resume."
        )
        .option("--out <file>", "Output file; .ts is concatenated as is, other containers go through ffmpeg -c copy")
        .option("--quality <value>", "best, worst, or a height such as 720", "best")
        .option("--stream <n>", "Which stream of the HAR: its number in --list, or a part of its URL")
        .option("--header <line>", 'Extra request header "Name: value" (repeatable)', collect, [])
        .option("--jobs <n>", "Segments downloaded at once", "6")
        .option("--idle-timeout <seconds>", "Treat a live stream as ended after this long with no new segment", "120")
        .option("--no-backfill", "Start at the live window instead of the oldest segment the CDN keeps")
        .option("--stitch-only", "Download nothing; stitch the segments already in <out>.parts")
        .option("--list", "List the HLS streams and player events in the HAR and exit")
        .option(
            "--chrome-cdp <page url>",
            "Record the page in your own browser over its debug port (reloads its open tab, or opens one) instead of reading a HAR; the HAR is saved for later runs"
        )
        .option(
            "--chrome-cdp-port <n>",
            "The browser's debug port (default: the browser with the page open, else 9222)"
        )
        .option("--chrome-cdp-wait <seconds>", "Longest time the page is recorded", "30")
        .option(
            "--wait-recording [minutes]",
            `While the broadcast is live or its recording is not made yet, wait for the full recording, asking every minute (default ${DEFAULT_RECORDING_WAIT_MINUTES} min)`
        )
        .option(
            "--from-stream",
            "Skip the platform's recording and download what the stream in the HAR still has (a CDN may have dropped the start)"
        )
        .option("--json", "Print the result as JSON")
        .action(async (input: string | undefined, flags: DownloadFlags) => {
            await runDownload(input, flags);
        });
}

function parseWaitRecording(value: boolean | string | undefined): number | undefined {
    if (value === undefined || value === false) {
        return undefined;
    }

    return value === true ? DEFAULT_RECORDING_WAIT_MINUTES : parseNonNegativeInt(value, "--wait-recording");
}

function listHar(log: HarLog, json: boolean | undefined): void {
    const candidates = harStreamCandidates(findLogPlaylists(log));
    const events = findProviderEvents(log);

    if (json) {
        out.result({
            streams: candidates.map(({ headers: _headers, ...candidate }) => candidate),
            events: events.map(({ request: _request, ...event }) => event),
        });
        return;
    }

    const lines = candidates.length ? listCandidates(candidates) : ["No HLS playlist in this HAR."];

    for (const event of events) {
        lines.push(`${describeEvent(event)}: ${event.capturedStatus} when recorded (${event.page ?? "unknown page"})`);
    }

    out.println(lines.join("\n"));
}

type RecordingOutcome =
    | { kind: "done" }
    | { kind: "live"; source: StreamSource }
    | { kind: "fallback" }
    /** The user chose to wait for a recording that is not made yet. */
    | { kind: "wait" };

/**
 * No recording yet: in a terminal, ask whether to wait for it or take the stream now (a platform does not always
 * publish the whole broadcast); elsewhere, print both commands and exit 1.
 */
async function chooseWithoutRecording({
    why,
    waited,
    rerun,
    json,
}: {
    why: string;
    waited?: number;
    rerun: string;
    json?: boolean;
}): Promise<RecordingOutcome> {
    if (isInteractive() && !json) {
        const choice = await p.select({
            message: `No recording yet: ${why}. What now?`,
            options: [
                {
                    value: "wait",
                    label: `Wait for the full recording (asks every minute, up to ${DEFAULT_RECORDING_WAIT_MINUTES} min)`,
                },
                {
                    value: "stream",
                    label: "Download the stream now (the CDN may have dropped the start, and an ended stream may be gone)",
                },
                { value: "stop", label: "Stop" },
            ],
        });

        if (choice === "wait") {
            return { kind: "wait" };
        }

        if (choice === "stream") {
            return { kind: "fallback" };
        }

        return { kind: "done" };
    }

    out.log.info(
        waited === undefined
            ? `Wait for it: ${rerun} --wait-recording`
            : `Waited ${waited} min. Wait longer: ${rerun} --wait-recording <minutes>`
    );
    out.log.info(`Or take what the stream still has: ${rerun} --from-stream`);
    process.exitCode = 1;
    return { kind: "done" };
}

/**
 * Asks the platform about a player event and downloads its finished recording. A live event hands its HLS stream back
 * to the stream downloader; an event without a recording falls back to the HAR's playlists.
 */
async function runRecording({
    event,
    flags,
    waitMinutes,
    rerun,
}: {
    event: ProviderEvent;
    flags: DownloadFlags;
    waitMinutes?: number;
    rerun: string;
}): Promise<RecordingOutcome> {
    const spinner = flags.json ? null : out.spinner();
    spinner?.start(`Asking ${providerById(event.provider).name} about ${describeEvent(event)}`);

    return await withInterrupt(
        async (signal): Promise<RecordingOutcome> => {
            const state = await awaitEventState({
                event,
                waitMinutes,
                signal,
                onWait: (current, nextAt) =>
                    spinner?.message(
                        `${current.kind === "live" ? "Still live" : "Recording not made yet"}; asking again at ${nextAt.toLocaleTimeString("en-GB")}`
                    ),
            });

            if (signal.aborted) {
                spinner?.stop("Stopped.");
                process.exitCode = 130;
                return { kind: "done" };
            }

            if (state.kind === "unavailable") {
                spinner?.stop(`${describeEvent(event)} has no recording: ${state.reason}.`);
                return { kind: "fallback" };
            }

            if (state.kind === "pending" || (state.kind === "live" && waitMinutes !== undefined)) {
                const why = state.kind === "live" ? "it is still live" : state.reason;
                spinner?.stop(`No recording of ${describeEvent(event)} yet: ${why}.`);
                return await chooseWithoutRecording({ why, waited: waitMinutes, rerun, json: flags.json });
            }

            if (state.kind === "live") {
                spinner?.stop(`${describeEvent(event)} is live; following its stream until it ends.`);
                out.log.info(`The full recording comes after it ends: ${rerun} --wait-recording`);
                return {
                    kind: "live",
                    source: { playlistUrl: state.playlistUrl, headers: state.headers, page: event.page },
                };
            }

            const output = resolve(flags.out ?? recordingOutputName(event));
            const started = Date.now();
            let lastShown = 0;
            spinner?.message(`Downloading the recording to ${output}`);
            const result = await downloadFile({
                url: state.url,
                headers: state.headers,
                output,
                signal,
                onProgress: ({ bytes, total, resumedFrom }) => {
                    const now = Date.now();

                    if (now - lastShown < PROGRESS_THROTTLE_MS) {
                        return;
                    }

                    lastShown = now;
                    const share = total ? ` of ${formatBytes(total)} (${((bytes / total) * 100).toFixed(1)}%)` : "";
                    const rate = (bytes - resumedFrom) / Math.max(0.001, (now - started) / 1000);
                    spinner?.message(`${formatBytes(bytes)}${share} at ${formatBytes(rate)}/s`);
                },
            });

            if (!result.complete) {
                spinner?.stop(`Stopped. ${formatBytes(result.bytes)} are kept in ${partFileFor(output)}`);
                out.log.info(`Resume: ${rerun} --out ${output}`);
                process.exitCode = 130;
                return { kind: "done" };
            }

            if (flags.json) {
                out.result({
                    kind: "recording",
                    provider: event.provider,
                    event: event.id,
                    title: event.title,
                    output,
                    bytes: result.bytes,
                    resumedFrom: result.resumedFrom,
                });
                return { kind: "done" };
            }

            spinner?.stop(`Saved ${output}`);
            out.log.info(`${formatBytes(result.bytes)}, the full recording from ${providerById(event.provider).name}.`);
            return { kind: "done" };
        },
        { handleTermination: true }
    );
}

async function runDownload(argInput: string | undefined, flags: DownloadFlags): Promise<void> {
    if (flags.chromeCdp && argInput) {
        out.log.error("Pass a HAR file or a playlist URL, or --chrome-cdp <page url>, not both.");
        process.exitCode = 1;
        return;
    }

    const jobs = parseNonNegativeInt(flags.jobs, "--jobs");
    const idleTimeoutSec = parseNonNegativeInt(flags.idleTimeout, "--idle-timeout");
    const waitMinutes = parseWaitRecording(flags.waitRecording);

    if (jobs < 1) {
        out.log.error("--jobs must be 1 or more.");
        process.exitCode = 1;
        return;
    }

    let input = argInput;
    let log: HarLog | undefined;

    if (flags.chromeCdp) {
        const spinner = flags.json ? null : out.spinner();
        spinner?.start(`Recording ${flags.chromeCdp} in your browser`);
        const capture = await captureFromBrowser({
            pageUrl: flags.chromeCdp,
            port: flags.chromeCdpPort ? parseNonNegativeInt(flags.chromeCdpPort, "--chrome-cdp-port") : undefined,
            maxSeconds: parseNonNegativeInt(flags.chromeCdpWait, "--chrome-cdp-wait"),
        });
        spinner?.stop(
            `Recorded ${capture.entries} requests in the browser on port ${capture.port} (${capture.portReason}${capture.openedTab ? ", in a new tab" : ", by reloading its tab"})`
        );
        out.log.info(`The HAR is saved; later runs can read it: ${capture.harPath}`);
        input = capture.harPath;
        log = capture.log;
    } else if (input && !/^https?:\/\//i.test(input)) {
        log = await readHar(input);
    }

    if (flags.list) {
        if (!log) {
            out.log.error("--list needs a HAR file or --chrome-cdp.");
            process.exitCode = 1;
            return;
        }

        listHar(log, flags.json);
        return;
    }

    let source: StreamSource | undefined;
    const events = log ? findProviderEvents(log) : [];

    if (input && events.length > 0 && !flags.fromStream) {
        if (events.length > 1) {
            out.log.warn(
                `The HAR shows ${events.length} player events; using the newest, ${describeEvent(events.at(-1) ?? events[0])}.`
            );
        }

        const event = events.at(-1) ?? events[0];
        const rerun = toolCommand("video", "stream", "download", input);
        let outcome = await runRecording({ event, flags, waitMinutes, rerun });

        if (outcome.kind === "wait") {
            outcome = await runRecording({ event, flags, waitMinutes: DEFAULT_RECORDING_WAIT_MINUTES, rerun });
        }

        if (outcome.kind === "done") {
            return;
        }

        if (outcome.kind === "live") {
            source = outcome.source;
        }
    }

    source ??= input ? await resolveSource({ input, log, stream: flags.stream, headerFlags: flags.header }) : undefined;
    const outputName = flags.out ?? (source ? defaultOutputName(source) : null);

    if (!outputName) {
        out.log.error("Pass a HAR file or a playlist URL, or --out of an earlier run to resume or stitch it.");
        process.exitCode = 1;
        return;
    }

    const output = resolve(outputName);

    if (!input && !(await readState(partsDirFor(output))) && !flags.stitchOnly) {
        out.log.error(`${partsDirFor(output)} has no earlier run to resume. Pass the HAR file or the playlist URL.`);
        process.exitCode = 1;
        return;
    }

    const resumeCommand = toolCommand("video", "stream", "download", ...(input ? [input] : []), "--out", output);
    const spinner = flags.json ? null : out.spinner();
    let lastShown = 0;
    spinner?.start(`Output ${output}`);

    await withInterrupt(
        async (signal) => {
            try {
                const result = await downloadStream({
                    output,
                    source,
                    quality: flags.quality,
                    concurrency: jobs,
                    idleTimeoutMs: idleTimeoutSec * 1000,
                    backfill: flags.backfill,
                    stitchOnly: flags.stitchOnly === true,
                    signal,
                    onProgress: (progress) => {
                        const now = Date.now();

                        if (now - lastShown >= PROGRESS_THROTTLE_MS || progress.phase === "stitching") {
                            lastShown = now;
                            spinner?.message(describeProgress(progress));
                        }
                    },
                });

                if (flags.json) {
                    out.result(result);
                    return;
                }

                if (result.aborted) {
                    spinner?.stop(`Stopped. ${result.segments} segments are kept in ${result.partsDir}`);
                    out.log.info(`Resume: ${resumeCommand}`);
                    out.log.info(`Stitch what is there: ${resumeCommand} --stitch-only`);
                    process.exitCode = 130;
                    return;
                }

                spinner?.stop(`Saved ${result.output}`);
                out.log.info(
                    `${result.segments} segments (#${result.firstSequence} to #${result.lastSequence}), ${result.downloadedThisRun} new this run, ${formatBytes(result.bytesThisRun)}.`
                );

                if (result.gaps.length > 0) {
                    const shown = result.gaps.slice(0, 20).join(", ");
                    const more = result.gaps.length > 20 ? ` and ${result.gaps.length - 20} more` : "";
                    out.log.warn(
                        `${result.gaps.length} segments are missing (the CDN no longer had them): ${shown}${more}`
                    );
                }

                if (!result.ended) {
                    out.log.warn(`The stream may still be live. Download the rest: ${resumeCommand}`);
                }

                out.log.info(`The segments stay in ${result.partsDir} for a resume; remove the folder when done.`);
            } catch (error) {
                if (signal.aborted) {
                    spinner?.stop("Stopped.");
                    out.log.info(`Resume: ${resumeCommand}`);
                    process.exitCode = 130;
                    return;
                }

                spinner?.stop("Failed.");
                throw error;
            }
        },
        { handleTermination: true }
    );
}
