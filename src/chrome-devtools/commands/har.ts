import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { inspectPidFile } from "@genesiscz/utils/process/pidfile";
import type { Command } from "commander";
import type { HarFile } from "../lib/har/types.ts";
import { buildHarFromBuffer, captureLiveWindow, parseDuration, sanitizeHar } from "../lib/har-io.ts";
import { captureDir, recorderPidPath } from "../lib/paths.ts";
import { artifactPath } from "../lib/platform.ts";
import { probeCdp } from "../lib/recorder.ts";
import { segmentStats } from "../lib/status.ts";
import { positiveNumber, resolvePort, suggest, withPage } from "./shared.ts";

const DEFAULT_HAR_OUT = artifactPath("cdp.har");

interface HarOpts {
    port?: string;
    match?: string;
    out?: string;
    last?: string;
    now?: boolean;
    reload?: boolean;
    seconds?: string;
    fromBuffer?: boolean;
    sanitize?: boolean;
    analyze?: boolean;
    bodies?: boolean;
    summary?: boolean;
}

function clock(ms: number | null): string {
    return ms === null ? "?" : new Date(ms).toTimeString().slice(0, 8);
}

/** One line per entry: the OAuth-assertion table (method/status/sizes/auth shape) without har-analyzer round-trips. */
function printHarSummary(har: HarFile): void {
    for (const e of har.log.entries) {
        const auth = e.request.headers.find((h) => h.name.toLowerCase() === "authorization")?.value ?? "";
        const authShape = auth ? (auth.split(" ")[0] ?? "yes") : "-";
        const reqSize = e.request.postData?.text?.length ?? e.request.bodySize ?? 0;
        const respSize = e.response?.content.size ?? e.response?.bodySize ?? 0;
        out.println(
            `${e.startedDateTime.slice(11, 19)}  ${e.request.method.padEnd(6)} ${String(e.response?.status ?? "-").padEnd(4)} req=${String(reqSize).padEnd(7)} resp=${String(respSize).padEnd(8)} auth=${authShape.padEnd(7)} ${e.request.url.slice(0, 110)}`
        );
    }

    out.println(
        `\n${har.log.entries.length} entries. Columns: time method status req-bytes resp-bytes auth-scheme url`
    );
}

async function writeHarFile(
    har: HarFile,
    opts: { sanitize?: boolean; analyze?: boolean; out: string; droppedFailed: number; note: string }
): Promise<void> {
    const outHar = opts.sanitize ? sanitizeHar(har) : har;
    await Bun.write(opts.out, SafeJSON.stringify(outHar, { strict: true }, 2));
    out.log.info(`${outHar.log.entries.length} entries, ${outHar.log.pages.length} page(s) -> ${opts.out}`);
    out.log.info(opts.note);

    if (opts.droppedFailed > 0) {
        out.log.warn(
            `${opts.droppedFailed} failed request(s) are NOT in the HAR (the format cannot represent network-level failures). See them: ${suggest(["follow", "--channels", "error"])}`
        );
    }

    if (!opts.sanitize) {
        out.log.warn(
            "this HAR can contain cookies, tokens, and POST passwords. Before sharing: re-run with --sanitize, or tools har-analyzer export --sanitize --strip-bodies -o clean.har"
        );
    }

    out.log.info(`Do not cat/jq the file. Next: tools har-analyzer load ${opts.out}`);

    if (opts.analyze) {
        const proc = Bun.spawn(["tools", "har-analyzer", "load", opts.out], {
            stdio: ["ignore", "inherit", "inherit"],
        });
        await proc.exited;
    }
}

export function registerHar(program: Command): void {
    withPage(program.command("har"))
        .description(
            "write a DevTools-grade HAR 1.2: retroactively from the recorder's buffer (default), or from a live window on one tab (--now / --reload)"
        )
        .option("-o, --out <file>", "HAR path", DEFAULT_HAR_OUT)
        .option("--last <duration>", "only events from the last 90s / 30m / 2h (buffer mode; bare number = minutes)")
        .option("--now", "ignore the buffer; record a live window on one tab from this moment")
        .option("--reload", "live window: reload the tab first so load-time requests (and bodies) are captured")
        .option("--seconds <n>", "live-window length (default 8 with --reload, else 15)")
        .option("--from-buffer", "dump a leftover buffer although its recorder already exited")
        .option(
            "--sanitize",
            "redact Cookie, Set-Cookie, Authorization headers, cookie values, and password/token/code POST params"
        )
        .option("--no-bodies", "live window: skip Network.getResponseBody calls")
        .option("--analyze", "run tools har-analyzer load on the result")
        .option(
            "--summary",
            "also print one line per entry (time, method, status, req/resp bytes, auth scheme, url) — the one-shot assertion table"
        )
        .addHelpText(
            "after",
            `
Examples:
  ${suggest(["har", "-o", DEFAULT_HAR_OUT, "--last", "30m"])}            # what happened in the last 30 min
  ${suggest(["har", "--now", "--reload", "-o", DEFAULT_HAR_OUT])}        # fresh load of the current tab, with bodies
  ${suggest(["har", "--from-buffer", "--port", "9222", "-o", "x.har"])} # recorder died, dump what it left
  ${suggest(["har", "-o", "clean.har", "--sanitize", "--analyze"])}

Buffer dumps are metadata + headers: response bodies are physically gone once
a tab navigates (Chrome discards them — Chromium #141129). For bodies use
--now --reload, or start the recorder with --channels +body.`
        )
        .action(async (opts: HarOpts) => {
            const port = await resolvePort(opts);

            if (opts.now || opts.reload) {
                if (!(await probeCdp(port))) {
                    out.log.error(`no CDP endpoint on port ${port} — nothing listens there.`);
                    out.log.info(`  see what is live: ${suggest(["attach"])}`);
                    process.exit(1);
                }

                const seconds = positiveNumber(opts.seconds, opts.reload ? 8 : 15, "--seconds");
                let live: Awaited<ReturnType<typeof captureLiveWindow>>;
                try {
                    live = await captureLiveWindow({
                        port,
                        match: opts.match,
                        reload: opts.reload,
                        seconds,
                        bodies: opts.bodies !== false,
                        onAttached: (page) => {
                            out.log.info(
                                `recording a live window on ${page.target.url.slice(0, 90)} for ${seconds}s (CDP only sees traffic after attach)...`
                            );
                        },
                    });
                } catch (err) {
                    out.log.error(err instanceof Error ? err.message : String(err));
                    out.log.info(`See open tabs first: ${suggest(["targets", "--port", String(port)])}`);
                    process.exit(1);
                }

                await writeHarFile(live.har, {
                    sanitize: opts.sanitize,
                    analyze: opts.analyze,
                    out: opts.out ?? DEFAULT_HAR_OUT,
                    droppedFailed: live.droppedFailed,
                    note:
                        live.har.log.entries.length === 0
                            ? "0 entries: CDP starts empty at attach. Re-run with --reload, or longer --seconds while you reproduce."
                            : `live window on ${live.pageUrl.slice(0, 90)} (bodies ${live.bodiesGot}, missing ${live.bodiesMiss})`,
                });

                if (opts.summary) {
                    printHarSummary(opts.sanitize ? sanitizeHar(live.har) : live.har);
                }

                process.exit(0);
            }

            const recorder = inspectPidFile(recorderPidPath(port));
            const stats = segmentStats(port);

            if (recorder.status !== "live" && stats.count === 0) {
                out.log.error(`nothing to dump on ${port}: no recorder and no buffer under ${captureDir(port)}.`);
                out.log.info(
                    `  start recording: ${suggest(["record", "--port", String(port), "--all-tabs"])}   (or just: ${suggest(["attach"])})`
                );
                out.log.info(
                    `  or a live window right now: ${suggest(["har", "--port", String(port), "--now", "--reload"])}`
                );
                process.exit(1);
            }

            if (recorder.status !== "live" && !opts.fromBuffer) {
                out.log.error(
                    `the recorder on ${port} is not running; the buffer (${stats.count} segment(s), ${Math.round(stats.bytes / 1024)} KB) is a leftover.`
                );
                out.log.info(
                    `  dump it anyway: ${suggest(["har", "--port", String(port), "--from-buffer", "-o", String(opts.out ?? DEFAULT_HAR_OUT)])}`
                );
                out.log.info(`  or record fresh: ${suggest(["record", "--port", String(port), "--all-tabs"])}`);
                process.exit(1);
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

            const built = buildHarFromBuffer({ port, sinceMs, match: opts.match });

            if (built.har.log.entries.length === 0) {
                // An empty window must never read as "no traffic": say what the
                // buffer actually holds so a too-narrow --last is self-evident.
                out.log.warn(
                    `0 entries${opts.last ? ` in the last ${opts.last}` : ""}${opts.match ? ` matching '${opts.match}'` : ""} — but the buffer holds ${built.coverage.totalEvents} event(s) covering ${clock(built.coverage.oldestT)}-${clock(built.coverage.newestT)}. An empty window is NOT proof of no traffic; widen --last or drop --match.`
                );
            }

            await writeHarFile(built.har, {
                sanitize: opts.sanitize,
                analyze: opts.analyze,
                out: opts.out ?? DEFAULT_HAR_OUT,
                droppedFailed: built.droppedFailed,
                note:
                    built.har.log.entries.length === 0
                        ? "0 entries written (see the coverage warning above)."
                        : `from the ${recorder.status === "live" ? "live" : "leftover"} buffer (metadata + headers${built.stitchedBodies ? `, ${built.stitchedBodies} captured bodies` : ""}). Bodies of a fresh load: --now --reload.`,
            });

            if (opts.summary) {
                printHarSummary(opts.sanitize ? sanitizeHar(built.har) : built.har);
            }

            process.exit(0);
        });
}
