import { basename, dirname, resolve } from "node:path";
import { isInteractive, parseNonNegativeInt } from "@genesiscz/utils/cli";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { formatBytes } from "@genesiscz/utils/format";
import { type HarLog, readHar } from "@genesiscz/utils/hls/har";
import { downloadFile, partFileFor } from "@genesiscz/utils/http/download-file";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import type { Command } from "commander";
import { captureFromBrowser } from "./capture";
import { describeChoices, gatherChoices, pickChoice, type SourceChoice } from "./choices";
import { downloadStream, partsDirFor, readState, type StreamProgress } from "./download";
import { type ProviderEvent, providerById } from "./providers";
import { awaitEventState, describeEvent, recordingOutputName } from "./recording";
import { parseHeaderFlags, type StreamSource, withDefaultHeaders } from "./source";

const PROGRESS_THROTTLE_MS = 200;

interface DownloadFlags {
    out?: string;
    quality?: string;
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
            "Download a broadcast from a HAR file, a playlist URL, or a page in your browser (--chrome-cdp). It lists every source the HAR leads to (a platform's original recording, the page's replay, the live stream) and takes the one you pick. A live HLS stream is followed from its oldest available segment until it ends, then stitched. Run it again with the same --out to resume."
        )
        .option("--out <file>", "Output file; .ts is concatenated as is, other containers go through ffmpeg -c copy")
        .option("--quality <value>", "best (default), worst, or a height such as 720")
        .option("--stream <n|id>", "Which source: its number or [--stream id] in --list, or a part of a playlist URL")
        .option("--header <line>", 'Extra request header "Name: value" (repeatable)', collect, [])
        .option("--jobs <n>", "Segments downloaded at once", "6")
        .option("--idle-timeout <seconds>", "Treat a live stream as ended after this long with no new segment", "120")
        .option("--no-backfill", "Start at the live window instead of the oldest segment the CDN keeps")
        .option("--stitch-only", "Download nothing; stitch the segments already in <out>.parts")
        .option("--list", "List the sources the HAR leads to, each checked now, and exit")
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
            `While the broadcast is live or its recording is not made yet, wait for the platform's recording, asking every minute (default ${DEFAULT_RECORDING_WAIT_MINUTES} min)`
        )
        .option("--from-stream", "Never take the platform's recording; only the HLS streams are offered")
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

/** A choice without its headers (cookies, tokens), for `--list --json`. */
function publicChoice(choice: SourceChoice) {
    const base = { id: choice.id, kind: choice.kind, label: choice.label };

    switch (choice.kind) {
        case "recording":
            return { ...base, provider: choice.event.provider, event: choice.event.id, title: choice.event.title };
        case "pending":
            return { ...base, provider: choice.event.provider, event: choice.event.id, reason: choice.reason };
        default:
            return {
                ...base,
                playlist: choice.source.playlistUrl,
                page: choice.source.page,
                ended: choice.ended,
                durationSec: choice.durationSec,
                height: choice.height,
                error: choice.error,
            };
    }
}

/** Downloads a platform's finished recording, resumable from `<out>.part`. */
async function downloadRecording({
    event,
    url,
    headers,
    flags,
    rerun,
}: {
    event: ProviderEvent;
    url: string;
    headers: Record<string, string>;
    flags: DownloadFlags;
    rerun: string;
}): Promise<void> {
    const output = resolve(flags.out ?? recordingOutputName(event));
    const spinner = flags.json ? null : out.spinner();
    const started = Date.now();
    let lastShown = 0;
    spinner?.start(`Downloading the recording to ${output}`);

    await withInterrupt(
        async (signal) => {
            const result = await downloadFile({
                url,
                headers,
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
                return;
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
                return;
            }

            spinner?.stop(`Saved ${output}`);
            out.log.info(`${formatBytes(result.bytes)}, the full recording from ${providerById(event.provider).name}.`);
        },
        { handleTermination: true }
    );
}

/** Waits for a player event's recording (`waitMinutes`), then downloads it; still nothing ends with exit 1. */
async function waitForRecording({
    event,
    flags,
    waitMinutes,
    rerun,
}: {
    event: ProviderEvent;
    flags: DownloadFlags;
    waitMinutes: number;
    rerun: string;
}): Promise<void> {
    const spinner = flags.json ? null : out.spinner();
    spinner?.start(`Waiting for the recording of ${describeEvent(event)}`);
    const state = await withInterrupt(
        (signal) =>
            awaitEventState({
                event,
                waitMinutes,
                signal,
                onWait: (current, nextAt) =>
                    spinner?.message(
                        `${current.kind === "live" ? "Still live" : "Recording not made yet"}; asking again at ${nextAt.toLocaleTimeString("en-GB")}`
                    ),
            }),
        { handleTermination: true }
    );

    if (state.kind !== "recorded") {
        const why = state.kind === "live" ? "it is still live" : state.reason;
        spinner?.stop(`No recording of ${describeEvent(event)}: ${why}.`);

        if (state.kind !== "unavailable") {
            out.log.info(`Waited ${waitMinutes} min. Wait longer: ${rerun} --wait-recording <minutes>`);
        }

        out.log.info(`See the other sources: ${rerun} --list`);
        process.exitCode = 1;
        return;
    }

    spinner?.stop(`The recording of ${describeEvent(event)} is ready.`);
    await downloadRecording({ event, url: state.url, headers: state.headers, flags, rerun });
}

/**
 * The source to take: `--stream`, else the only one, else a pick in a terminal (the best one first), else the best one.
 * A best source that is a recording still to be made is not taken without a terminal: waiting is a choice.
 */
async function chooseSource({
    choices,
    flags,
    rerun,
}: {
    choices: SourceChoice[];
    flags: DownloadFlags;
    rerun: string;
}): Promise<SourceChoice | null> {
    const usable = choices.filter((choice) => !(choice.kind === "stream" && choice.error));

    if (flags.stream !== undefined) {
        const picked = pickChoice(choices, flags.stream);

        if (!picked) {
            out.log.error(`--stream ${flags.stream} matches none of:\n${describeChoices(choices).join("\n")}`);
            process.exitCode = 1;
            return null;
        }

        return picked;
    }

    if (usable.length === 0) {
        out.log.error(
            choices.length
                ? `No source can be downloaded:\n${describeChoices(choices).join("\n")}`
                : "The HAR leads to no stream and no player recording. Record it while the video plays, or use --chrome-cdp."
        );
        process.exitCode = 1;
        return null;
    }

    if (usable.length === 1) {
        return usable[0];
    }

    if (isInteractive() && !flags.json) {
        const picked = await p.select({
            message: "Which source? (the best one is first)",
            options: usable.map((choice) => ({ value: choice.id, label: choice.label })),
            initialValue: usable[0].id,
        });
        return usable.find((choice) => choice.id === picked) ?? null;
    }

    const best = usable[0];

    if (best.kind === "pending") {
        out.log.warn(`No source is ready to download:\n${describeChoices(choices).join("\n")}`);
        out.log.info(`Wait for the recording: ${rerun} --wait-recording`);
        out.log.info(`Or take a stream now: ${rerun} --stream <id>`);
        process.exitCode = 1;
        return null;
    }

    out.log.info(`Taking "${best.label}". Another source: ${rerun} --stream <id> (--list shows them).`);
    return best;
}

async function runStream({
    source,
    input,
    flags,
    streamId,
}: {
    source?: StreamSource;
    input?: string;
    flags: DownloadFlags;
    /** The `--stream` value that picks this stream again, for the printed resume command. */
    streamId?: string;
}): Promise<void> {
    const jobs = parseNonNegativeInt(flags.jobs, "--jobs");
    const idleTimeoutSec = parseNonNegativeInt(flags.idleTimeout, "--idle-timeout");
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

    const resumeCommand = toolCommand(
        "video",
        "stream",
        "download",
        ...(input ? [input] : []),
        "--out",
        output,
        ...(flags.quality ? ["--quality", flags.quality] : []),
        ...(input && streamId ? ["--stream", streamId] : [])
    );
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

                if (result.failed.length > 0 && !result.aborted) {
                    process.exitCode = 1;
                }

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

                if (result.failed.length > 0) {
                    const shown = result.failed.slice(0, 20).join(", ");
                    const more = result.failed.length > 20 ? ` and ${result.failed.length - 20} more` : "";
                    spinner?.stop(
                        `Not stitched: ${result.failed.length} segments still failed after the retries (${shown}${more}).`
                    );
                    out.log.info(`Retry them: ${resumeCommand}`);
                    out.log.info(`Stitch without them: ${resumeCommand} --stitch-only`);
                    return;
                }

                spinner?.stop(`Saved ${result.output}`);
                out.log.info(
                    `${result.segments} segments (#${result.firstSequence} to #${result.lastSequence}), ${result.downloadedThisRun} new this run, ${formatBytes(result.bytesThisRun)}.`
                );

                if (result.gone.length > 0) {
                    const shown = result.gone.slice(0, 20).join(", ");
                    const more = result.gone.length > 20 ? ` and ${result.gone.length - 20} more` : "";
                    out.log.warn(
                        `${result.gone.length} segments are missing (the CDN no longer had them): ${shown}${more}`
                    );
                }

                const unexplained = result.gaps.filter((sequence) => !result.gone.includes(sequence));

                if (unexplained.length > 0) {
                    out.log.warn(`${unexplained.length} more segments are missing between the first and the last.`);
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

async function runDownload(argInput: string | undefined, flags: DownloadFlags): Promise<void> {
    if (flags.chromeCdp && argInput) {
        out.log.error("Pass a HAR file or a playlist URL, or --chrome-cdp <page url>, not both.");
        process.exitCode = 1;
        return;
    }

    const waitMinutes = parseWaitRecording(flags.waitRecording);

    if (parseNonNegativeInt(flags.jobs, "--jobs") < 1) {
        out.log.error("--jobs must be 1 or more.");
        process.exitCode = 1;
        return;
    }

    let input = argInput;
    let log: HarLog | undefined;
    let earlierEvents: ProviderEvent[] = [];

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
        earlierEvents = capture.earlierEvents;
    } else if (input && !/^https?:\/\//i.test(input)) {
        log = await readHar(input);
    }

    const extraHeaders = parseHeaderFlags(flags.header);

    if (!log) {
        if (flags.list) {
            out.log.error("--list needs a HAR file or --chrome-cdp.");
            process.exitCode = 1;
            return;
        }

        const source = input ? { playlistUrl: input, headers: withDefaultHeaders(extraHeaders) } : undefined;
        await runStream({ source, input, flags });
        return;
    }

    const harInput = input ?? "";
    const rerun = toolCommand("video", "stream", "download", harInput);
    const spinner = flags.json || flags.list ? null : out.spinner();
    spinner?.start("Checking the sources the HAR leads to");
    const { choices: all, events } = await gatherChoices({ log, earlierEvents, extraHeaders });
    const choices = flags.fromStream ? all.filter((choice) => choice.kind === "stream") : all;
    spinner?.stop(`${choices.length} sources found.`);

    if (flags.list) {
        if (flags.json) {
            out.result(choices.map(publicChoice));
            return;
        }

        out.println(choices.length ? describeChoices(choices).join("\n") : "No stream and no player recording here.");
        return;
    }

    if (waitMinutes !== undefined && !flags.fromStream && flags.stream === undefined) {
        const event = events.at(-1);

        if (!event) {
            out.log.error("--wait-recording needs a player event (StreamYard) in the HAR; this one has none.");
            process.exitCode = 1;
            return;
        }

        await waitForRecording({ event, flags, waitMinutes, rerun });
        return;
    }

    const choice = await chooseSource({ choices, flags, rerun });

    if (!choice) {
        return;
    }

    if (choice.kind === "recording") {
        await downloadRecording({ event: choice.event, url: choice.url, headers: choice.headers, flags, rerun });
        return;
    }

    if (choice.kind === "pending") {
        await waitForRecording({
            event: choice.event,
            flags,
            waitMinutes: waitMinutes ?? DEFAULT_RECORDING_WAIT_MINUTES,
            rerun,
        });
        return;
    }

    await runStream({ source: choice.source, input: harInput, flags, streamId: choice.id });
}
