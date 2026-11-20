import { mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseNonNegativeInt } from "@genesiscz/utils/cli";
import { pickEnumFlag } from "@genesiscz/utils/cli/enum-flag";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { parseSince } from "@genesiscz/utils/date";
import {
    formatBytes,
    formatDuration,
    formatRelativeTime,
    formatTimecode,
    parseDuration,
    parseTimecode,
} from "@genesiscz/utils/format";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, formatDotStatus, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import { type ClipDownloadRow, downloadClips, mapPool } from "./download";
import {
    CLIPS_MANIFEST_FILE,
    type ClipsManifest,
    findOverlaps,
    type ManifestClip,
    providerSection,
    readManifest,
    recordClips,
    recordVods,
    writeManifest,
} from "./manifest";
import { CLIP_PROVIDERS } from "./providers";
import { CLIP_PROVIDER_IDS, CLIP_RANGES, type Clip, type ClipProvider, type ClipRange, type Vod } from "./types";
import { downloadVodPart } from "./vod";

interface ListFlags {
    sort?: string | boolean;
    range?: string | boolean;
    limit: string;
    since?: string;
    json?: boolean;
}

interface DownloadFlags extends ListFlags {
    outDir: string;
    jobs: string;
    force?: boolean;
}

interface VodFlags {
    clip?: string;
    pad: string;
    from?: string;
    to?: string;
    quality?: string;
    outDir: string;
    force?: boolean;
    json?: boolean;
}

interface ManifestFlags {
    backfill?: boolean;
    jobs: string;
    json?: boolean;
}

function isRange(value: string): value is ClipRange {
    return CLIP_RANGES.some((range) => range === value);
}

function command(provider: ClipProvider, ...words: string[]): string {
    return toolCommand("video", provider.id, ...words);
}

/** The flag wins, then the page URL's own `sort` and `range`, then the provider's defaults. */
async function listFilters({
    provider,
    subcommand,
    flags,
    fromUrl,
}: {
    provider: ClipProvider;
    subcommand: string;
    flags: ListFlags;
    fromUrl: { sort?: string; range?: ClipRange };
}): Promise<{ sort: string; range: ClipRange; limit: number; since?: Date } | null> {
    const tool = command(provider, subcommand);
    const sort = await pickEnumFlag({
        tool,
        subcommand: [provider.id, subcommand],
        flag: "--sort",
        given: flags.sort,
        values: provider.sorts,
        fallback: fromUrl.sort ?? provider.sorts[0],
        accepts: (value): value is string => provider.sorts.includes(value),
    });

    if (!sort) {
        return null;
    }

    const range = await pickEnumFlag({
        tool,
        subcommand: [provider.id, subcommand],
        flag: "--range",
        given: flags.range,
        values: CLIP_RANGES,
        fallback: fromUrl.range ?? provider.defaultRange,
        accepts: isRange,
    });

    if (!range) {
        return null;
    }

    const limit = parseNonNegativeInt(flags.limit, "--limit");

    if (flags.since === undefined) {
        return { sort, range, limit };
    }

    const since = parseSinceFlag(flags.since);

    if (!since) {
        out.log.error(`--since "${flags.since}" is neither a duration (12h, 90m, 2d) nor a time (HH:MM, an ISO date)`);
        process.exitCode = 1;
        return null;
    }

    return { sort, range, limit, since };
}

/** `12h`, `90m`, `2d` count back from now; `HH:MM` and ISO dates name the instant. */
function parseSinceFlag(value: string): Date | null {
    const at = parseSince(value);

    if (at) {
        return at;
    }

    const ms = parseDuration(value);
    return ms > 0 ? new Date(Date.now() - ms) : null;
}

function renderClipTable(clips: Clip[]): void {
    const table = createBoxTable(["#", "CLIP", "TITLE", "LENGTH", "VIEWS", "AGE", "CLIPPED BY"]);

    for (const [index, clip] of clips.entries()) {
        table.push([
            String(index + 1),
            truncateDisplay(clip.id, 32),
            truncateDisplay(clip.title, 40),
            formatDuration(clip.durationSec, "s"),
            String(clip.views),
            formatRelativeTime(new Date(clip.createdAt), { compact: true }),
            truncateDisplay(clip.creator ?? "", 20),
        ]);
    }

    out.println(table.toString());
}

async function runList(provider: ClipProvider, input: string, flags: ListFlags): Promise<void> {
    const target = provider.parseTarget(input);

    if (target.kind !== "channel") {
        const next = target.kind === "clip" ? "download" : "download-vod";
        out.log.error(
            `"${input}" is one ${target.kind}, not a channel. Download it: ${command(provider, next, input)}`
        );
        process.exitCode = 1;
        return;
    }

    const filters = await listFilters({ provider, subcommand: "list-clips", flags, fromUrl: target });

    if (!filters) {
        return;
    }

    const clips = await withInterrupt((signal) => provider.listClips({ channel: target.channel, ...filters, signal }), {
        handleTermination: true,
    });

    if (flags.json) {
        out.result({ provider: provider.id, channel: target.channel, ...filters, clips });
        return;
    }

    if (clips.length === 0) {
        out.log.warn(`${target.channel} has no clips for sort ${filters.sort}, range ${filters.range}.`);
        return;
    }

    renderClipTable(clips);
    const since = filters.since ? `, since ${filters.since.toLocaleString("en-GB")}` : "";
    const reached = clips.length === filters.limit ? `, --limit ${filters.limit} reached` : "";
    out.log.info(
        `${clips.length} clips of ${target.channel} (sort ${filters.sort}, range ${filters.range}${since}${reached}).`
    );
    out.log.info(
        `Download them: ${command(provider, "download", target.channel, "--sort", filters.sort, "--range", filters.range, "--limit", String(filters.limit), ...(flags.since ? ["--since", flags.since] : []))}`
    );
}

/** Every clip the arguments name: clip URLs and ids one each, channels and clips pages through the list. */
async function resolveClips({
    provider,
    inputs,
    flags,
    signal,
}: {
    provider: ClipProvider;
    inputs: string[];
    flags: DownloadFlags;
    signal: AbortSignal;
}): Promise<Clip[] | null> {
    const clips: Clip[] = [];
    const seen = new Set<string>();

    for (const input of inputs) {
        const target = provider.parseTarget(input);
        let found: Clip[];

        if (target.kind === "clip") {
            found = [await provider.fetchClip(target.id, signal)];
        } else if (target.kind === "vod") {
            out.log.error(`"${input}" is a VOD. Cut it: ${command(provider, "download-vod", input)}`);
            process.exitCode = 1;
            return null;
        } else {
            const filters = await listFilters({ provider, subcommand: "download", flags, fromUrl: target });

            if (!filters) {
                return null;
            }

            found = await provider.listClips({ channel: target.channel, ...filters, signal });
        }

        for (const clip of found) {
            if (!seen.has(clip.id)) {
                seen.add(clip.id);
                clips.push(clip);
            }
        }
    }

    return clips;
}

/** Places the rows' clips in their VODs, merges rows and VODs into the folder's manifest and writes it. */
async function updateManifest({
    provider,
    dir,
    rows,
    jobs,
    signal,
}: {
    provider: ClipProvider;
    dir: string;
    rows: ClipDownloadRow[];
    jobs: number;
    signal: AbortSignal;
}): Promise<ClipsManifest> {
    // A manifest that does not parse fails here, before the requests, and is never overwritten.
    readManifest(dir);
    const { sources, vods } = await provider.placeClips({ clips: rows.map((row) => row.clip), jobs, signal });
    const manifest = readManifest(dir);
    const section = providerSection(manifest, provider.id);
    recordClips({ section, rows, sources });
    recordVods(section, vods);
    writeManifest(dir, manifest);
    return manifest;
}

function reportManifest(provider: ClipProvider, dir: string, manifest: ClipsManifest): void {
    const clips = CLIP_PROVIDER_IDS.flatMap((id) => Object.values(manifest.providers[id]?.clips ?? {}));
    const placed = clips.filter((clip) => clip.source?.vodOffsetSec != null).length;
    const duplicates = findOverlaps(manifest).filter((overlap) => overlap.duplicate).length;
    out.log.info(
        `Manifest ${join(dir, CLIPS_MANIFEST_FILE)}: ${clips.length} clips, ${placed} placed in their VOD, ${duplicates} duplicate pairs. Show it: ${command(provider, "manifest", dir)}`
    );
}

function publicRow(row: ClipDownloadRow, manifest: ClipsManifest) {
    return {
        provider: row.clip.provider,
        id: row.clip.id,
        title: row.clip.title,
        channel: row.clip.channel,
        createdAt: row.clip.createdAt,
        durationSec: row.clip.durationSec,
        page: row.clip.pageUrl,
        output: row.output,
        status: row.status,
        bytes: row.bytes,
        source: manifest.providers[row.clip.provider]?.clips[row.clip.id]?.source ?? null,
        ...(row.error ? { error: row.error } : {}),
    };
}

async function runDownload(provider: ClipProvider, inputs: string[], flags: DownloadFlags): Promise<void> {
    const outDir = resolve(flags.outDir);
    const jobs = Math.max(1, parseNonNegativeInt(flags.jobs, "--jobs"));

    await withInterrupt(
        async (signal) => {
            const clips = await resolveClips({ provider, inputs, flags, signal });

            if (!clips) {
                return;
            }

            if (clips.length === 0) {
                out.log.warn("No clips to download.");
                return;
            }

            mkdirSync(outDir, { recursive: true });
            const spinner = flags.json ? null : out.spinner();
            spinner?.start(`Downloading ${clips.length} clips to ${outDir}`);
            const rows = await downloadClips({
                provider,
                clips,
                outDir,
                jobs,
                force: Boolean(flags.force),
                signal,
                onRow: (row, done) => spinner?.message(`${done}/${clips.length}: ${row.status} ${row.clip.title}`),
            });
            const failed = rows.filter((row) => row.status === "failed");

            if (failed.length > 0) {
                process.exitCode = 1;
            }

            spinner?.message(`Reading where ${rows.length} clips sit in their VODs`);
            const manifest = await updateManifest({ provider, dir: outDir, rows, jobs, signal });

            if (flags.json) {
                out.result({
                    manifest: join(outDir, CLIPS_MANIFEST_FILE),
                    clips: rows.map((row) => publicRow(row, manifest)),
                });
                return;
            }

            const saved = rows.filter((row) => row.status === "saved");
            spinner?.stop(
                `${saved.length} saved, ${rows.length - saved.length - failed.length} already there, ${failed.length} failed`
            );
            const table = createBoxTable(["STATUS", "TITLE", "SIZE", "FILE"]);

            for (const row of rows) {
                const dot =
                    row.status === "saved"
                        ? formatDotStatus("ok", "saved")
                        : row.status === "exists"
                          ? formatDotStatus("dim", "exists")
                          : formatDotStatus("err", "failed");
                table.push([
                    dot,
                    truncateDisplay(row.clip.title, 36),
                    row.bytes ? formatBytes(row.bytes) : "",
                    row.error ? truncateDisplay(row.error, 60) : basename(row.output),
                ]);
            }

            out.println(table.toString());
            reportManifest(provider, outDir, manifest);
        },
        { handleTermination: true }
    );
}

/** Rows for the provider's clip files already in `dir`, each clip read again from the site. */
async function rowsFromFiles({
    provider,
    dir,
    jobs,
    signal,
}: {
    provider: ClipProvider;
    dir: string;
    jobs: number;
    signal: AbortSignal;
}): Promise<ClipDownloadRow[]> {
    const files = readdirSync(dir).filter((name) => provider.clipIdFromFileName(name) !== null);
    const rows: ClipDownloadRow[] = [];
    await mapPool({
        items: files,
        jobs,
        signal,
        task: async (name) => {
            const id = provider.clipIdFromFileName(name) ?? "";

            try {
                const clip = await provider.fetchClip(id, signal);
                rows.push({ clip, output: join(dir, name), status: "exists", bytes: statSync(join(dir, name)).size });
            } catch (error) {
                signal.throwIfAborted();
                logger.warn({ error, provider: provider.id, file: name }, "Clip of a file is not readable");
                out.log.warn(`${name}: ${error instanceof Error ? error.message : String(error)}; left out`);
            }
        },
    });
    return rows;
}

function offsetCell(clip: ManifestClip): string {
    const source = clip.source;

    if (source?.vodOffsetSec == null || source.vodEndOffsetSec == null) {
        return "";
    }

    const mark = source.offsetFrom === "stream-start" ? "~" : "";
    return `${mark}${formatTimecode(source.vodOffsetSec)}-${formatTimecode(source.vodEndOffsetSec)}`;
}

function renderManifest(manifest: ClipsManifest): number {
    const duplicateOf = new Map<string, string>();
    const insideOf = new Map<string, string>();

    for (const overlap of findOverlaps(manifest)) {
        if (overlap.duplicate) {
            duplicateOf.set(overlap.b.id, overlap.a.id);
        } else if (overlap.contained) {
            const [shorter, longer] =
                overlap.a.durationSec <= overlap.b.durationSec ? [overlap.a, overlap.b] : [overlap.b, overlap.a];
            insideOf.set(shorter.id, longer.id);
        }
    }

    let count = 0;

    for (const providerId of CLIP_PROVIDER_IDS) {
        const section = manifest.providers[providerId];
        const clips = Object.values(section?.clips ?? {});
        count += clips.length;
        const byStream = Map.groupBy(clips, (clip) => clip.source?.streamId ?? "");

        for (const [streamId, group] of [...byStream].sort(([a], [b]) => b.localeCompare(a))) {
            const vod = section?.vods[streamId];
            const head = vod
                ? `${vod.title} (${vod.startedAt.slice(0, 16).replace("T", " ")} UTC, ${vod.access}) ${vod.pageUrl ?? ""}`
                : streamId
                  ? `Stream ${streamId} (not in the channel's VOD list)`
                  : "No stream known";
            out.println(`${CLIP_PROVIDERS[providerId].label}: ${head}`);
            const table = createBoxTable(["IN VOD", "STREAM TIME", "TITLE", "LENGTH", "NOTE", "FILE"]);
            const sorted = group.sort(
                (a, b) =>
                    (a.source?.vodOffsetSec ?? 0) - (b.source?.vodOffsetSec ?? 0) ||
                    a.createdAt.localeCompare(b.createdAt)
            );

            for (const clip of sorted) {
                const twin = duplicateOf.get(clip.id);
                table.push([
                    offsetCell(clip),
                    clip.source?.startAt ? new Date(clip.source.startAt).toLocaleTimeString("en-GB") : "",
                    truncateDisplay(clip.title, 36),
                    formatDuration(clip.durationSec, "s"),
                    twin
                        ? `same as ${twin.slice(-6)}`
                        : insideOf.has(clip.id)
                          ? `inside ${insideOf.get(clip.id)?.slice(-6)}`
                          : clip.status === "failed"
                            ? "failed"
                            : "",
                    truncateDisplay(clip.file ?? "", 40),
                ]);
            }

            out.println(table.toString());
        }
    }

    out.log.info(
        `${count} clips, ${duplicateOf.size} duplicates of another clip, ${insideOf.size} inside a longer clip. "~" marks an offset counted from the stream start (the VOD playlist is closed), a few seconds off.`
    );
    return count;
}

async function runManifest(provider: ClipProvider, dirInput: string, flags: ManifestFlags): Promise<void> {
    const dir = resolve(dirInput);
    const jobs = Math.max(1, parseNonNegativeInt(flags.jobs, "--jobs"));
    let manifest = readManifest(dir);

    if (flags.backfill) {
        manifest = await withInterrupt(
            async (signal) => {
                const spinner = flags.json ? null : out.spinner();
                spinner?.start(`Reading the ${provider.label} clips of the files in ${dir}`);
                const rows = await rowsFromFiles({ provider, dir, jobs, signal });
                spinner?.message(`Reading where ${rows.length} clips sit in their VODs`);
                const updated = await updateManifest({ provider, dir, rows, jobs, signal });
                spinner?.stop(`${rows.length} ${provider.label} clip files recorded`);
                return updated;
            },
            { handleTermination: true }
        );
    }

    if (flags.json) {
        out.result({ path: join(dir, CLIPS_MANIFEST_FILE), manifest, overlaps: findOverlaps(manifest) });
        return;
    }

    if (renderManifest(manifest) === 0) {
        out.log.warn(
            `${join(dir, CLIPS_MANIFEST_FILE)} lists no clips. Record the files here: ${command(provider, "manifest", dirInput, "--backfill")}`
        );
    }
}

/** `1:02:03`, `62:03`, plain seconds or a duration (`90m`, `2h`), as seconds into the VOD. */
function parseOffsetFlag(flag: string, value: string): number {
    const timecode = parseTimecode(value);

    if (timecode !== null) {
        return timecode;
    }

    const ms = parseDuration(value);

    if (ms > 0) {
        return ms / 1000;
    }

    throw new Error(`${flag} "${value}" is neither a timecode (1:02:03, 62:03, 3723) nor a duration (90m, 2h)`);
}

async function clipFromInput(provider: ClipProvider, input: string, signal: AbortSignal): Promise<Clip> {
    const target = provider.parseTarget(input);

    if (target.kind !== "clip") {
        throw new Error(`--clip "${input}" is not a ${provider.label} clip URL or clip id`);
    }

    return provider.fetchClip(target.id, signal);
}

async function vodFromInput(provider: ClipProvider, input: string, signal: AbortSignal): Promise<Vod> {
    const target = provider.parseTarget(input);

    if (target.kind !== "vod") {
        throw new Error(`"${input}" is not a ${provider.label} VOD URL or VOD id`);
    }

    return provider.fetchVod(target.id, signal);
}

async function vodOfClip(provider: ClipProvider, clip: Clip, signal: AbortSignal): Promise<Vod> {
    if (!clip.streamId) {
        throw new Error(`${provider.label} names no stream for clip ${clip.id}`);
    }

    const listed = (await provider.listVods(clip.channel, signal)).find((vod) => vod.streamId === clip.streamId);
    return listed ?? provider.fetchVod(clip.streamId, signal);
}

async function runDownloadVod(provider: ClipProvider, input: string | undefined, flags: VodFlags): Promise<void> {
    if (!input && !flags.clip) {
        out.log.error(`Name a VOD or a clip: ${command(provider, "download-vod", "--clip", "<clip url>")}`);
        process.exitCode = 1;
        return;
    }

    const outDir = resolve(flags.outDir);
    const padSec = parseDuration(flags.pad) / 1000;

    await withInterrupt(
        async (signal) => {
            const clip = flags.clip ? await clipFromInput(provider, flags.clip, signal) : null;
            const vod = input
                ? await vodFromInput(provider, input, signal)
                : clip
                  ? await vodOfClip(provider, clip, signal)
                  : null;

            if (!vod) {
                throw new Error("Name a VOD or pass --clip");
            }

            const playback = await provider.vodPlayback({ vod, quality: flags.quality, signal });
            let fromSec = flags.from ? parseOffsetFlag("--from", flags.from) : 0;
            let toSec = flags.to ? parseOffsetFlag("--to", flags.to) : playback.durationSec;

            if (clip) {
                const placed = await provider.placeClips({ clips: [clip], jobs: 1, signal });
                const source = placed.sources.get(clip.id);

                if (source?.vodOffsetSec == null || source.vodEndOffsetSec == null) {
                    throw new Error(`The place of clip ${clip.id} in its VOD is unknown`);
                }

                fromSec = Math.max(0, source.vodOffsetSec - padSec);
                toSec = source.vodEndOffsetSec + padSec;
            }

            toSec = Math.min(toSec, playback.durationSec);

            if (toSec <= fromSec) {
                throw new Error(
                    `The range ${formatTimecode(fromSec)}-${formatTimecode(toSec)} is empty or past the VOD's end (${formatTimecode(playback.durationSec)})`
                );
            }

            mkdirSync(outDir, { recursive: true });
            const spinner = flags.json ? null : out.spinner();
            spinner?.start(
                `Cutting ${formatTimecode(fromSec)}-${formatTimecode(toSec)} of ${vod.title} (${playback.variantName})`
            );
            const result = await downloadVodPart({
                vod,
                playback,
                fromSec,
                toSec,
                outDir,
                force: Boolean(flags.force),
                signal,
            });
            const manifest = readManifest(outDir);
            const section = providerSection(manifest, provider.id);
            recordVods(section, [{ vod, playback }]);
            const file = basename(result.output);
            section.vodParts[file] = {
                file,
                vodId: vod.id,
                streamId: vod.streamId,
                vodPageUrl: vod.pageUrl,
                fromSec,
                toSec,
                quality: playback.variantName,
                bytes: result.bytes,
                savedAt: new Date().toISOString(),
                clipId: clip?.id ?? null,
            };
            writeManifest(outDir, manifest);

            if (flags.json) {
                out.result({ ...section.vodParts[file], status: result.status, output: result.output });
                return;
            }

            spinner?.stop(result.status === "saved" ? "Cut saved" : "Cut already there");
            out.log.info(`${result.output} (${formatBytes(result.bytes)})`);
        },
        { handleTermination: true }
    );
}

async function runVods(provider: ClipProvider, channelInput: string, flags: { json?: boolean }): Promise<void> {
    const target = provider.parseTarget(channelInput);

    if (target.kind !== "channel") {
        out.log.error(`"${channelInput}" is not a ${provider.label} channel`);
        process.exitCode = 1;
        return;
    }

    const vods = await withInterrupt((signal) => provider.listVods(target.channel, signal), {
        handleTermination: true,
    });

    if (flags.json) {
        out.result({ provider: provider.id, channel: target.channel, vods });
        return;
    }

    const table = createBoxTable(["STARTED", "TITLE", "LENGTH", "ACCESS", "VOD"]);

    for (const vod of vods) {
        table.push([
            new Date(vod.startedAt).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }),
            truncateDisplay(vod.title, 44),
            vod.live ? "live" : formatTimecode(vod.durationSec),
            vod.access === "public" ? formatDotStatus("ok", "public") : formatDotStatus("dim", vod.access),
            vod.pageUrl ?? "",
        ]);
    }

    out.println(table.toString());
    out.log.info(
        `${vods.length} VODs. Cut a part: ${command(provider, "download-vod", "<VOD url>", "--from", "1:00:00", "--to", "1:05:00")}`
    );
}

function filterOptions(provider: ClipProvider, subcommand: Command): Command {
    return subcommand
        .option(
            "--sort [value]",
            `${provider.sorts.join(", ")} (default: the page URL's sort, else ${provider.sorts[0]})`
        )
        .option(
            "--range [value]",
            `${CLIP_RANGES.join(", ")} (default: the page URL's range, else ${provider.defaultRange})`
        )
        .option("--limit <n>", "Most clips taken from each channel, 0 for all", "20")
        .option(
            "--since <when>",
            "Only clips made since then: a duration back from now (12h, 90m, 2d), HH:MM or an ISO date"
        )
        .option("--json", "Print the result as JSON");
}

/** `tools video <provider> list-clips|download|vods|download-vod|manifest`, the same five for every provider. */
export function registerClipCommands(program: Command, provider: ClipProvider): void {
    const root = program.command(provider.id).description(`List and download ${provider.label} clips and VODs`);

    filterOptions(
        provider,
        root
            .command("list-clips <channel>")
            .description(
                `List a channel's clips. <channel> is a name, a channel page or a clips page such as ${provider.exampleClipsUrl}`
            )
    ).action(async (input: string, flags: ListFlags) => {
        await runList(provider, input, flags);
    });

    filterOptions(
        provider,
        root
            .command("download <targets...>")
            .description(
                `Download clips as MP4 (ffmpeg -c copy, no re-encode). A target is a clip URL or id, or a channel or clips page, which downloads the clips list-clips shows for it. A clip already saved is skipped. The folder's ${CLIPS_MANIFEST_FILE} records each clip with its title, URL and place in its VOD.`
            )
            .option("--out-dir <dir>", "Folder for the MP4 files", ".")
            .option("--jobs <n>", "Clips downloaded at once", "3")
            .option("--force", "Download a clip again even when its file exists")
    ).action(async (inputs: string[], flags: DownloadFlags) => {
        await runDownload(provider, inputs, flags);
    });

    root.command("vods <channel>")
        .description("List a channel's streams and their VODs, with each VOD's access")
        .option("--json", "Print the result as JSON")
        .action(async (channel: string, flags: { json?: boolean }) => {
            await runVods(provider, channel, flags);
        });

    root.command("download-vod [vod]")
        .description(
            `Cut a VOD, or a part of it, into an MP4 (ffmpeg -c copy). [vod] is a VOD URL or id; with --clip it may be left out, and the cut is the clip's moment in its VOD plus --pad on each side. The cut is recorded in the folder's ${CLIPS_MANIFEST_FILE}.`
        )
        .option("--clip <clip>", "Cut the VOD around this clip (a clip URL or id)")
        .option("--pad <duration>", "With --clip: extra time before and after the clip", "30s")
        .option("--from <time>", "Start, into the VOD: 1:02:03, 62:03, seconds or 90m")
        .option("--to <time>", "End, into the VOD (default: the VOD's end)")
        .option("--quality <name>", "A variant such as 1080p, 720p or 480p (default: the highest)")
        .option("--out-dir <dir>", "Folder for the MP4", ".")
        .option("--force", "Cut again even when the file exists")
        .option("--json", "Print the result as JSON")
        .action(async (vod: string | undefined, flags: VodFlags) => {
            await runDownloadVod(provider, vod, flags);
        });

    root.command("manifest <dir>")
        .description(
            `Show a download folder's ${CLIPS_MANIFEST_FILE}: the clips by VOD with their time in the VOD and the duplicates. --backfill records the ${provider.label} clip files already in the folder.`
        )
        .option(
            "--backfill",
            `Read every ${provider.label} clip file in the folder again and record it with its VOD time`
        )
        .option("--jobs <n>", "Requests at once", "2")
        .option("--json", "Print the manifest and the overlaps as JSON")
        .action(async (dir: string, flags: ManifestFlags) => {
            await runManifest(provider, dir, flags);
        });
}

/** Every provider's command tree. */
export function registerAllClipCommands(program: Command): void {
    for (const id of CLIP_PROVIDER_IDS) {
        registerClipCommands(program, CLIP_PROVIDERS[id]);
    }
}
