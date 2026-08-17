/**
 * Getting the data in, and getting it back out.
 *
 * The harvest itself runs in a browser tab over the Chrome DevTools Protocol, so it cannot
 * be a subcommand; `harvest` prints the exact sequence and where the payloads live. The
 * enrichment crawls and the export writers are ordinary functions and run from here.
 */
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { common, emit } from "@app/spotify/commands/_shared";
import { autoHarvest } from "@app/spotify/lib/browser/harvest";
import { type CommonOpts, dateOption, numberOption } from "@app/spotify/lib/context";
import { toCsv } from "@app/spotify/lib/csv";
import { buildArtistIndex } from "@app/spotify/lib/enrich/build-artist-index";
import { enrichLastfm } from "@app/spotify/lib/enrich/lastfm";
import { mergeGenres } from "@app/spotify/lib/enrich/merge-genres";
import { type MergeHistoryGrouping, mergeHistory } from "@app/spotify/lib/enrich/merge-history";
import { enrichMusicbrainz } from "@app/spotify/lib/enrich/musicbrainz";
import { progress, writeJsonl } from "@app/spotify/lib/io";
import { cacheDir } from "@app/spotify/lib/paths";
import { getProfile } from "@app/spotify/lib/profiles";
import { doctorReport, exportReport, parseExportKind } from "@app/spotify/lib/reports/pipeline";
import { renderDoctor, renderExportPreview, renderHarvestGuide } from "@app/spotify/render/pipeline";
import { int } from "@app/spotify/render/text";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { formatTable } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

const ENRICH_SOURCES = ["musicbrainz", "mb", "lastfm", "lf", "both"] as const;
type EnrichSource = (typeof ENRICH_SOURCES)[number];

/** Without this, `enrich typo` skipped both crawls, re-merged, and exited 0. */
function parseEnrichSource(source: string | undefined): EnrichSource {
    const which = (source ?? "both") as EnrichSource;
    if (!ENRICH_SOURCES.includes(which)) {
        throw new Error(`unknown source "${source}". Pick one of: ${ENRICH_SOURCES.join(", ")}`);
    }

    return which;
}

const EXPORT_FORMATS = ["csv", "jsonl", "json"] as const;
type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Without this, `--format jsno --out report.json` wrote CSV into the file and exited 0. */
function parseExportFormat(format: string | undefined, out: string): ExportFormat {
    if (format === undefined) {
        return out.endsWith(".jsonl") ? "jsonl" : out.endsWith(".json") ? "json" : "csv";
    }

    const which = format as ExportFormat;
    if (!EXPORT_FORMATS.includes(which)) {
        throw new Error(`unknown --format "${format}". Pick one of: ${EXPORT_FORMATS.join(", ")}`);
    }

    return which;
}

const GROUPINGS: readonly MergeHistoryGrouping[] = ["tracks", "artists", "genres"];

function parseGrouping(by: string | undefined): MergeHistoryGrouping {
    const which = (by ?? "tracks") as MergeHistoryGrouping;
    if (!GROUPINGS.includes(which)) {
        throw new Error(`unknown --by "${by}". Pick one of: ${GROUPINGS.join(", ")}`);
    }

    return which;
}

/**
 * Returns the RESOLVED profile, not just its directory, because commands that fail need to
 * name it. `loadArtistIndex` prints the exact `tools spotify build` to run next, and with only
 * a path in hand every caller omitted `--profile`, so the printed fix rebuilt the default
 * profile and left the real one just as broken.
 */
function requireData(name?: string): { name: string; dataDir: string } {
    const p = getProfile(name);
    if (!p.dataDir) {
        throw new Error(
            `profile "${p.name}" has no data directory.\n  tools spotify profile add ${p.name} --data <dir>`
        );
    }

    return { name: p.name, dataDir: p.dataDir };
}

const reportProgress = (label: string) => {
    const startedAt = Date.now();

    return (done: number, total: number) => {
        out.printlnErr(pc.gray(`  ${label} ${progress(done, total, startedAt)}`));
    };
};

export function registerPipeline(program: Command): void {
    program
        .command("harvest")
        .description("pull the library out of a logged-in browser tab (--auto does it for you)")
        .option("--auto", "do it automatically over CDP instead of printing the manual steps")
        .option("-p, --profile <name>", "profile whose data directory receives the harvest")
        .option("--out <path>", "write here instead of the profile's data directory")
        .option("--browser-url <url>", "CDP endpoint of the signed-in browser")
        .option("--json", "machine-readable output")
        .action(async (o: { auto?: boolean; profile?: string; out?: string; browserUrl?: string; json?: boolean }) => {
            if (!o.auto) {
                renderHarvestGuide();

                return;
            }

            const target = o.out ?? join(requireData(o.profile).dataDir, "spotify_library.jsonl");
            const result = await autoHarvest({
                browserUrl: o.browserUrl ?? env.spotify.getBrowserUrl() ?? "http://127.0.0.1:9222",
                onLog: (line) => out.printlnErr(pc.gray(`  ${line}`)),
            });

            writeJsonl(target, result.tracks);

            emit(o.json, { ...result, tracks: undefined, out: target }, (r) => {
                out.println(`harvested ${int(r.unique)} liked tracks of ${int(r.total ?? r.unique)} → ${target}`);

                if (r.errors.length) {
                    out.println(pc.yellow(`  ${r.errors.length} page(s) failed; rerun to fill the gaps`));
                }

                out.println(pc.gray(`  next: tools spotify build --profile ${o.profile ?? "me"}`));
            });
        });

    program
        .command("build")
        .description("turn a raw harvest into the track library")
        .option("-p, --profile <name>", "profile to build for")
        .option("--since <date>", "tracks saved on or after this date are crawled first")
        .option("--json", "machine-readable output")
        .action((o: { profile?: string; since?: string; json?: boolean }) => {
            const result = buildArtistIndex({
                dataDir: requireData(o.profile).dataDir,
                since: dateOption(o.since, "since"),
            });
            emit(o.json, result, (r) => {
                if (r.convertedFrom) {
                    out.println(`converted ${r.convertedFrom} -> ${r.jsonlPath} (${int(r.tracks)} tracks)`);
                } else {
                    out.println(`read ${r.jsonlPath} (${int(r.tracks)} tracks)`);
                }

                out.println(`artists: ${int(r.artists)} total, ${int(r.recentArtists)} added since ${r.since}`);
            });
        });

    program
        .command("enrich [source]")
        .description("fetch genre tags: musicbrainz | lastfm | both (default)")
        .option("-p, --profile <name>", "profile to enrich")
        .option("--key <key>", "deprecated: pass the Last.fm API key in LASTFM_API_KEY instead")
        .option("--limit <n>", "stop after this many artists (resumable, so a partial run is useful)")
        .action(async (source: string | undefined, o: { profile?: string; key?: string; limit?: string }) => {
            const { name: profile, dataDir } = requireData(o.profile);
            const which = parseEnrichSource(source);
            if (o.key) {
                // Kept working because the standalone skill had it, but a key in argv lands in
                // shell history and in every `ps` listing on the machine. The enricher already
                // reads LASTFM_API_KEY, which is where a credential belongs.
                out.log.warn("--key puts the API key in your shell history; prefer LASTFM_API_KEY");
            }

            // A whole number of at least 1: both enrichers apply the cap under `if (opts.limit)`
            // and slice with it, so `--limit 0` would silently start the full ~50-minute crawl
            // and `--limit -1` would fetch every artist but the last.
            const limit = o.limit ? numberOption(o.limit, "limit", 0, { min: 1, integer: true }) : undefined;

            if (which === "musicbrainz" || which === "mb" || which === "both") {
                const r = await enrichMusicbrainz({
                    dataDir,
                    profile,
                    limit,
                    onProgress: reportProgress("musicbrainz"),
                });
                out.println(`musicbrainz: ${int(r.total)} artists, ${int(r.cached)} cached, ${int(r.fetched)} fetched`);
            }

            if (which === "lastfm" || which === "lf" || which === "both") {
                const r = await enrichLastfm({
                    dataDir,
                    profile,
                    limit,
                    apiKey: o.key,
                    onProgress: reportProgress("lastfm"),
                });
                out.println(
                    `lastfm (${r.mode}): ${int(r.total)} artists, ${int(r.cached)} cached, ${int(r.fetched)} fetched`
                );
            }

            printGenreMerge(mergeGenres({ dataDir }));
        });

    program
        .command("genres-merge")
        .description("re-merge tags onto tracks after editing the vocabulary")
        .option("-p, --profile <name>", "profile to merge for")
        .option("--since <date>", "window for the printed breakdown")
        .option("--min <n>", "drop genres with fewer tracks than this")
        .option("--top <n>", "only show this many genres")
        .option("--json", "machine-readable output")
        .action((o: { profile?: string; since?: string; min?: string; top?: string; json?: boolean }) => {
            const result = mergeGenres({
                dataDir: requireData(o.profile).dataDir,
                since: dateOption(o.since, "since"),
                minTracks: o.min ? numberOption(o.min, "min", 1) : undefined,
                top: o.top ? numberOption(o.top, "top", 0) : undefined,
            });
            emit(o.json, result, printGenreMerge);
        });

    program
        .command("history-merge")
        .description("join the streaming history onto the harvested library (writes spotify_library.full.jsonl)")
        .option("-p, --profile <name>", "profile to merge for")
        .option("--history <dir>", "override the streaming-history directory")
        .option("--since <date>", "ignore events before this date")
        .option("--by <what>", "tracks | artists | genres", "tracks")
        .option("--top <n>", "rows to print", "25")
        .option("--json", "machine-readable output")
        .action(
            (o: { profile?: string; history?: string; since?: string; by?: string; top?: string; json?: boolean }) => {
                const profile = getProfile(o.profile);
                const result = mergeHistory({
                    dataDir: requireData(o.profile).dataDir,
                    historyDir: o.history ?? profile.historyDir,
                    since: dateOption(o.since, "since"),
                    by: parseGrouping(o.by),
                    top: o.top ? numberOption(o.top, "top", 25) : undefined,
                });

                emit(o.json, result, (r) => {
                    out.println(
                        `history: ${r.files} files, ${int(r.events)} events` +
                            `${r.eventsWithoutUri ? ` (${int(r.eventsWithoutUri)} without a track uri — podcasts/audiobooks)` : ""}` +
                            `${r.since ? `, filtered to >= ${r.since}` : ""}`
                    );
                    out.println(
                        `         ${int(r.distinctTracks)} distinct tracks, ${int(r.totalPlays)} plays (>=30s), ${r.totalHours.toFixed(0)} hours`
                    );
                    out.println(
                        `library: ${int(r.library.total)} liked tracks, ${int(r.library.matched)} of them appear in the history ` +
                            `(${Math.floor((r.library.matched * 100) / Math.max(1, r.library.total))}%)\n`
                    );
                    const headers =
                        r.by === "tracks"
                            ? ["track", "artist", "plays", "hours", "liked"]
                            : r.by === "artists"
                              ? ["artist", "plays", "hours"]
                              : ["genre", "plays", "hours", "tracks"];
                    out.println(
                        formatTable(
                            r.rows.map((row) =>
                                r.by === "tracks"
                                    ? [
                                          row.label,
                                          row.sub ?? "",
                                          String(row.plays),
                                          row.hours.toFixed(1),
                                          row.liked ? "yes" : "no",
                                      ]
                                    : r.by === "artists"
                                      ? [row.label, String(row.plays), row.hours.toFixed(1)]
                                      : [row.label, String(row.plays), row.hours.toFixed(1), String(row.extra ?? 0)]
                            ),
                            headers
                        )
                    );
                });
            }
        );

    common(
        program
            .command("export [what]")
            .description("write the full ranking to disk: tracks | songs | artists | library")
            .option("--out <path>", "output file; extension picks CSV or JSONL")
            .option("--format <fmt>", "csv, jsonl or json (overrides the extension)"),
        { topDescription: "how many rows the preview shows (--out always writes every row)" }
    ).action(async (what: string | undefined, o: CommonOpts & { out?: string; format?: string }) => {
        const result = exportReport(parseExportKind(what), o);

        if (!o.out) {
            // The preview is capped, so the payload has to SAY it is capped. Emitting a bare
            // 200-row array let a script read a truncated export as the whole ranking, with
            // nothing in the output to distinguish the two. The human renderer already prints
            // the true total.
            const TABLE_ROWS = 15;
            const JSON_ROWS = 200;
            const limit = o.top ? numberOption(o.top, "top", JSON_ROWS, { min: 1, integer: true }) : undefined;
            const preview = result.objects.slice(0, limit ?? JSON_ROWS);

            emit(
                o.json,
                {
                    kind: result.kind,
                    preview: true,
                    total: result.objects.length,
                    limit: limit ?? JSON_ROWS,
                    truncated: result.objects.length > preview.length,
                    hint: "pass --out <path> to write every row",
                    rows: preview,
                },
                () => renderExportPreview(result, limit ?? TABLE_ROWS)
            );

            return;
        }

        const format = parseExportFormat(o.format, o.out);
        if (format === "jsonl") {
            await Bun.write(o.out, `${result.objects.map((r) => SafeJSON.stringify(r)).join("\n")}\n`);
        } else if (format === "json") {
            await Bun.write(o.out, SafeJSON.stringify(result.objects, null, 2));
        } else {
            await Bun.write(o.out, toCsv(result.headers, result.rows));
        }

        // With `--json` the caller wants a payload on stdout, not prose: say where the file
        // went in machine-readable form.
        emit(o.json, { kind: result.kind, out: o.out, format, rows: result.objects.length }, () => {
            out.println(`wrote ${int(result.objects.length)} rows to ${o.out}`);
        });
    });

    program
        .command("doctor")
        .description("what data each profile has, what is missing, and the next command to run")
        .option("--json", "machine-readable output")
        .action((o: { json?: boolean }) => {
            emit(o.json, doctorReport(), renderDoctor);
        });

    program
        .command("cache-clear")
        .description("drop the parsed-history cache (safe; it rebuilds on the next command)")
        .action(() => {
            const dir = cacheDir();
            if (!existsSync(dir)) {
                out.println("no cache directory.");

                return;
            }

            // Only files this cache itself wrote: `<sanitized profile>-<16 hex>.json`.
            // Deleting every *.json in the directory trusted SPOTIFY_CACHE_DIR completely, and
            // that variable is one plausible typo away from a data directory — where the same
            // sweep would take `artists.json` with it and cost an hour of re-crawling.
            const files = readdirSync(dir);
            const mine = files.filter((f) => /^[a-zA-Z0-9._-]+-[0-9a-f]{16}\.json$/.test(f));

            for (const f of mine) {
                unlinkSync(join(dir, f));
            }

            const spared = files.length - mine.length;
            out.println(
                `removed ${mine.length} cache file(s) from ${dir}` +
                    (spared ? ` · left ${spared} unrelated file(s) alone` : "")
            );
        });
}

function printGenreMerge(r: ReturnType<typeof mergeGenres>): void {
    out.println(
        `sources: MusicBrainz ${int(r.sources.musicbrainzArtists)} artists, Last.fm ${int(r.sources.lastfmArtists)}; ` +
            `vocabulary ${int(r.sources.vocabulary)} genres`
    );
    out.println(
        `library: ${int(r.library.tracks)} tracks, ${int(r.library.tagged)} tagged ` +
            `(${Math.floor((r.library.tagged * 100) / Math.max(1, r.library.tracks))}%)`
    );
    out.println(
        `added since ${r.since}: ${int(r.window.tracks)} tracks, ${int(r.window.tagged)} tagged ` +
            `(${Math.floor((r.window.tagged * 100) / Math.max(1, r.window.tracks))}%), ${int(r.window.distinctGenres)} distinct genres\n`
    );
    out.println(
        formatTable(
            r.genres.map((g) => [g.genre, String(g.tracks), `${g.share.toFixed(1)}%`]),
            ["genre", "tracks", "share"]
        )
    );
}
