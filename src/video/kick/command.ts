import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseNonNegativeInt } from "@genesiscz/utils/cli";
import { pickEnumFlag } from "@genesiscz/utils/cli/enum-flag";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { formatBytes, formatDuration, formatRelativeTime } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, formatDotStatus, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import {
    fetchKickClip,
    KICK_CLIP_RANGES,
    KICK_CLIP_SORTS,
    type KickClip,
    type KickClipRange,
    type KickClipSort,
    listKickClips,
    parseKickTarget,
} from "./api";
import { type ClipDownloadRow, downloadKickClips } from "./download";

const DEFAULT_SORT: KickClipSort = "date";
const DEFAULT_RANGE: KickClipRange = "all";

interface ListFlags {
    sort?: string | boolean;
    range?: string | boolean;
    limit: string;
    json?: boolean;
}

interface DownloadFlags extends ListFlags {
    outDir: string;
    jobs: string;
    force?: boolean;
}

function isSort(value: string): value is KickClipSort {
    return KICK_CLIP_SORTS.some((sort) => sort === value);
}

function isRange(value: string): value is KickClipRange {
    return KICK_CLIP_RANGES.some((range) => range === value);
}

/** The flag wins, then the page URL's own `sort` and `range`, then the defaults. */
async function listFilters({
    subcommand,
    flags,
    fromUrl,
}: {
    subcommand: string;
    flags: ListFlags;
    fromUrl: { sort?: KickClipSort; range?: KickClipRange };
}): Promise<{ sort: KickClipSort; range: KickClipRange; limit: number } | null> {
    const tool = toolCommand("video", "kick", subcommand);
    const sort = await pickEnumFlag({
        tool,
        subcommand: ["kick", subcommand],
        flag: "--sort",
        given: flags.sort,
        values: KICK_CLIP_SORTS,
        fallback: fromUrl.sort ?? DEFAULT_SORT,
        accepts: isSort,
    });

    if (!sort) {
        return null;
    }

    const range = await pickEnumFlag({
        tool,
        subcommand: ["kick", subcommand],
        flag: "--range",
        given: flags.range,
        values: KICK_CLIP_RANGES,
        fallback: fromUrl.range ?? DEFAULT_RANGE,
        accepts: isRange,
    });

    if (!range) {
        return null;
    }

    const limit = parseNonNegativeInt(flags.limit, "--limit");
    return { sort, range, limit: Math.max(1, limit) };
}

function clipAge(clip: KickClip): string {
    return formatRelativeTime(new Date(clip.createdAt), { compact: true });
}

function renderClipTable(clips: KickClip[]): void {
    const table = createBoxTable(["#", "CLIP", "TITLE", "LENGTH", "VIEWS", "AGE", "CLIPPED BY"]);

    for (const [index, clip] of clips.entries()) {
        table.push([
            String(index + 1),
            clip.id,
            truncateDisplay(clip.title, 40),
            formatDuration(clip.durationSec, "s"),
            String(clip.views),
            clipAge(clip),
            truncateDisplay(clip.creator ?? "", 20),
        ]);
    }

    out.println(table.toString());
}

function publicRow(row: ClipDownloadRow) {
    return {
        id: row.clip.id,
        title: row.clip.title,
        channel: row.clip.channel,
        createdAt: row.clip.createdAt,
        durationSec: row.clip.durationSec,
        page: row.clip.pageUrl,
        output: row.output,
        status: row.status,
        bytes: row.bytes,
        ...(row.error ? { error: row.error } : {}),
    };
}

async function runList(input: string, flags: ListFlags): Promise<void> {
    const target = parseKickTarget(input);

    if (target.kind !== "channel") {
        out.log.error(
            `"${input}" is one clip, not a channel. Download it: ${toolCommand("video", "kick", "download", input)}`
        );
        process.exitCode = 1;
        return;
    }

    const filters = await listFilters({ subcommand: "list-clips", flags, fromUrl: target });

    if (!filters) {
        return;
    }

    const clips = await withInterrupt((signal) => listKickClips({ channel: target.channel, ...filters, signal }), {
        handleTermination: true,
    });

    if (flags.json) {
        out.result({ channel: target.channel, ...filters, clips });
        return;
    }

    if (clips.length === 0) {
        out.log.warn(`${target.channel} has no clips for sort ${filters.sort}, range ${filters.range}.`);
        return;
    }

    renderClipTable(clips);
    out.log.info(
        `${clips.length} clips of ${target.channel} (sort ${filters.sort}, range ${filters.range}${clips.length === filters.limit ? `, --limit ${filters.limit} reached` : ""}).`
    );
    out.log.info(
        `Download them: ${toolCommand("video", "kick", "download", target.channel, "--sort", filters.sort, "--range", filters.range, "--limit", String(filters.limit))}`
    );
}

/** Every clip the arguments name: clip URLs and ids one each, channels and clips pages through the list API. */
async function resolveClips({
    inputs,
    flags,
    signal,
}: {
    inputs: string[];
    flags: DownloadFlags;
    signal: AbortSignal;
}): Promise<KickClip[] | null> {
    const clips: KickClip[] = [];
    const seen = new Set<string>();

    for (const input of inputs) {
        const target = parseKickTarget(input);
        let found: KickClip[];

        if (target.kind === "clip") {
            found = [await fetchKickClip(target.id, signal)];
        } else {
            const filters = await listFilters({ subcommand: "download", flags, fromUrl: target });

            if (!filters) {
                return null;
            }

            found = await listKickClips({ channel: target.channel, ...filters, signal });
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

async function runDownload(inputs: string[], flags: DownloadFlags): Promise<void> {
    const outDir = resolve(flags.outDir);
    const jobs = Math.max(1, parseNonNegativeInt(flags.jobs, "--jobs"));

    await withInterrupt(
        async (signal) => {
            const clips = await resolveClips({ inputs, flags, signal });

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
            const rows = await downloadKickClips({
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

            if (flags.json) {
                out.result(rows.map(publicRow));
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
                    row.error ? truncateDisplay(row.error, 60) : row.output,
                ]);
            }

            out.println(table.toString());
        },
        { handleTermination: true }
    );
}

export function registerKickCommands(program: Command): void {
    const kick = program.command("kick").description("List and download Kick clips");

    const filterOptions = (command: Command) =>
        command
            .option(
                "--sort [value]",
                `${KICK_CLIP_SORTS.join(" or ")} (default: the page URL's sort, else ${DEFAULT_SORT})`
            )
            .option(
                "--range [value]",
                `${KICK_CLIP_RANGES.join(", ")} (default: the page URL's range, else ${DEFAULT_RANGE})`
            )
            .option("--limit <n>", "Most clips taken from each channel", "20")
            .option("--json", "Print the result as JSON");

    filterOptions(
        kick
            .command("list-clips <channel>")
            .description(
                "List a channel's clips. <channel> is a slug, a channel page or a clips page such as https://kick.com/somechannel/clips?sort=date&range=day"
            )
    ).action(async (input: string, flags: ListFlags) => {
        await runList(input, flags);
    });

    filterOptions(
        kick
            .command("download <targets...>")
            .description(
                "Download clips as MP4 (ffmpeg -c copy, no re-encode). A target is a clip URL or id, or a channel or clips page URL, which downloads the clips list-clips shows for it. A clip already saved is skipped."
            )
            .option("--out-dir <dir>", "Folder for the MP4 files", ".")
            .option("--jobs <n>", "Clips downloaded at once", "3")
            .option("--force", "Download a clip again even when its file exists")
    ).action(async (inputs: string[], flags: DownloadFlags) => {
        await runDownload(inputs, flags);
    });
}
