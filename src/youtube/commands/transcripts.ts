import { renderColumns } from "@app/youtube/commands/_shared/columns";
import { getYoutube } from "@app/youtube/commands/_shared/ensure-pipeline";
import { renderOrEmit } from "@app/youtube/commands/_shared/render";
import { resolveTargetsToVideoIds } from "@app/youtube/commands/_shared/utils";
import {
    exportTranscripts,
    importTranscriptDir,
    renderTranscript,
    type TranscriptExportFormat,
} from "@app/youtube/lib/transcript-export";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";

/**
 * Move transcripts between the database and a directory of files.
 *
 * `json` is the lossless format and the one `import` round-trips; markdown keeps
 * `[mm:ss] text` lines and recovers starts only, with ends inferred. That
 * asymmetry is why `--format` defaults to json for export.
 */

const FORMATS: TranscriptExportFormat[] = ["md", "json", "txt", "srt", "vtt"];

interface ExportOpts {
    dir: string;
    format: string;
    overwrite?: boolean;
    json?: boolean;
}

interface ShowOpts {
    format: string;
    json?: boolean;
}

function parseFormat(value: string): TranscriptExportFormat | null {
    return FORMATS.includes(value as TranscriptExportFormat) ? (value as TranscriptExportFormat) : null;
}

export function registerTranscriptsCommand(program: Command): void {
    const transcripts = program.command("transcripts").description("Export, import and print stored transcripts");

    transcripts
        .command("export <targets...>")
        .description("Write stored transcripts to a directory")
        .requiredOption("--dir <path>", "Destination directory")
        .option("--format <format>", `One of: ${FORMATS.join(", ")}`, "json")
        .option("--overwrite", "Rewrite files that already exist")
        .option("--json", "Machine-readable output")
        .action(async (targets: string[], opts: ExportOpts, cmd: Command) => {
            const yt = await getYoutube();
            const format = parseFormat(opts.format);

            if (!format) {
                out.error(`Unknown format "${opts.format}". Use one of: ${FORMATS.join(", ")}`);
                process.exitCode = 1;
                return;
            }

            const result = await exportTranscripts({
                db: yt.db,
                videoIds: await resolveTargetsToVideoIds(yt, targets),
                dir: opts.dir,
                format,
                overwrite: opts.overwrite,
            });

            const text = renderColumns({
                rows: result.written,
                emptyMessage: "(nothing exported)",
                schema: [
                    { header: "VIDEO", get: (row) => row.videoId },
                    { header: "PATH", get: (row) => row.path },
                    { header: "BYTES", get: (row) => String(row.bytes) },
                ],
            });

            await renderOrEmit({ text, json: result, flags: cmd.optsWithGlobals() });
        });

    transcripts
        .command("import")
        .description("Import a directory of exported transcripts into the database")
        .requiredOption("--dir <path>", "Source directory")
        .option("--json", "Machine-readable output")
        .action(async (opts: { dir: string; json?: boolean }, cmd: Command) => {
            const yt = await getYoutube();
            const result = await importTranscriptDir({ db: yt.db, dir: opts.dir });

            const text = [
                `imported: ${result.imported.length}`,
                result.skipped.length > 0 ? pc.dim(`skipped: ${result.skipped.length}`) : "",
            ]
                .filter(Boolean)
                .join("\n");

            await renderOrEmit({ text, json: result, flags: cmd.optsWithGlobals() });
        });

    transcripts
        .command("show <target>")
        .description("Print one stored transcript")
        .option("--format <format>", `One of: ${FORMATS.join(", ")}`, "txt")
        .option("--json", "Machine-readable output")
        .action(async (target: string, opts: ShowOpts, cmd: Command) => {
            const yt = await getYoutube();
            const format = parseFormat(opts.format);

            if (!format) {
                out.error(`Unknown format "${opts.format}". Use one of: ${FORMATS.join(", ")}`);
                process.exitCode = 1;
                return;
            }

            const [videoId] = await resolveTargetsToVideoIds(yt, [target]);

            if (!videoId) {
                out.error(`Could not resolve "${target}" to a video id.`);
                process.exitCode = 1;
                return;
            }

            const transcript = yt.db.getTranscript(videoId);

            if (!transcript) {
                out.error(`No transcript stored for ${videoId}.`);
                process.exitCode = 1;
                return;
            }

            const video = yt.db.getVideo(videoId);
            const text = renderTranscript(
                {
                    id: videoId,
                    title: video?.title ?? videoId,
                    channelHandle: video?.channelHandle ?? "",
                    uploadDate: video?.uploadDate ?? null,
                    durationSec: video?.durationSec ?? null,
                },
                transcript,
                format
            );

            await renderOrEmit({ text, json: { videoId, transcript }, flags: cmd.optsWithGlobals() });
        });
}
