/** net-panel — dump the DevTools Network panel's own NetworkLog (the log Preserve log filled). */
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { Conn, Page, targets } from "../lib/cdp.ts";
import { sanitizeHar } from "../lib/har-io.ts";
import {
    AmbiguousDevToolsTargetError,
    DEFAULT_DOCUMENT_LIMIT,
    disambiguatingMatch,
    NoDevToolsTargetError,
    PANEL_DUMP_SCRIPT,
    PANEL_READ_TIMEOUT_MS,
    type PanelSummary,
    panelDumpToHar,
    parsePanelDump,
    pickDevToolsTarget,
    summarizePanel,
    withDeadline,
} from "../lib/net-panel.ts";
import { positiveNumber, resolvePort, suggest, withPage } from "./shared.ts";

interface NetPanelOpts {
    port?: string;
    match?: string;
    json?: boolean;
    out?: string;
    fullUrls?: boolean;
    documents?: string;
}

function histogramLine(label: string, counts: Record<string, number>, limit: number): string {
    const pairs = Object.entries(counts)
        .sort((a, z) => z[1] - a[1])
        .slice(0, limit)
        .map(([key, n]) => `${key}=${n}`);

    return `${label.padEnd(10)} ${pairs.join("  ")}`;
}

function printSummary(summary: PanelSummary): void {
    out.println(`${summary.count} requests in the panel NetworkLog of ${summary.inspector}`);
    out.println("");
    out.println(histogramLine("methods", summary.methods, 10));
    out.println(histogramLine("statuses", summary.statuses, 12));
    out.println(histogramLine("types", summary.resourceTypes, 12));
    out.println(histogramLine("hosts", summary.hosts, 15));

    if (summary.failed > 0) {
        out.println(`failed     ${summary.failed}`);
    }

    if (summary.documents.length > 0) {
        out.println("");
        out.println("document hops (origin+path only — query and fragment are dropped):");
        for (const d of summary.documents) {
            out.println(`  ${d.method.padEnd(7)} ${String(d.status).padEnd(4)} ${d.url}`);
        }
    }
}

export function registerNetPanel(program: Command): void {
    withPage(program.command("net-panel"))
        .description(
            "dump the OPEN DevTools Network panel's own log (what Preserve log already collected) — the history neither the recorder buffer nor the MCP request list can reach"
        )
        .addHelpText(
            "after",
            `
Three different network logs exist; this verb reads the THIRD:
  1. recorder buffer     'har --last 30m'  — events since THIS tool's recorder started
  2. MCP attach log      list_network_requests — events since THAT MCP session attached
  3. panel NetworkLog    net-panel         — what the user's own Network tab is showing

--match names the INSPECTED TAB (or the inspector itself, 'DevTools - <host>').
The DevTools window is then resolved by TITLE: every inspector shares one
devtools:// url, so a url-based pick would dump a different tab's log.

Urls are cut to origin+pathname by default; --full-urls keeps query strings and
runs them through the HAR sanitizer instead. Headers, cookies and POST bodies are
never collected at all.`
        )
        .option("--summary", "histograms + document hops — accepted for readability, it is already the default view")
        .option("--json", "the summary as JSON on stdout")
        .option("-o, --out <file.har>", "also write a HAR of the panel rows (no headers, no bodies)")
        .option("--full-urls", "keep query strings and fragments (sanitized) instead of cutting them off")
        .option("--documents <n>", "how many document hops to print", String(DEFAULT_DOCUMENT_LIMIT))
        .action(async (opts: NetPanelOpts) => {
            const port = await resolvePort(opts);

            if (!opts.match) {
                out.log.error("net-panel needs --match to name the inspected tab; it never guesses which panel.");
                out.log.info(`  see what is open: ${suggest(["targets", "--port", String(port), "--all"])}`);
                process.exit(1);
            }

            let all: Awaited<ReturnType<typeof targets>>;

            try {
                all = await targets(port);
            } catch (err) {
                // A refused connection here would otherwise surface as a raw Bun
                // stack trace over cdp.ts, which teaches the reader nothing about
                // the one thing that is wrong: no browser is listening.
                out.log.error(`nothing is answering CDP on port ${port}: ${err instanceof Error ? err.message : err}`);
                out.log.info(`  see what IS live: ${suggest(["attach"])}`);
                out.log.info(
                    "  --remote-debugging-port is read at browser STARTUP, so it cannot be switched on for a browser that is already up."
                );
                process.exit(1);
            }

            let pick: ReturnType<typeof pickDevToolsTarget>;

            try {
                pick = pickDevToolsTarget(all, opts.match);
            } catch (err) {
                if (err instanceof AmbiguousDevToolsTargetError) {
                    // Picking the first of several would read a DIFFERENT tab's log and
                    // say nothing, which is the exact failure the title rule exists to stop.
                    out.log.error(`${err.message} on port ${port}.`);

                    if (err.kind === "tab") {
                        out.log.info("These tabs all match, so --match has to name one of them:");
                    } else {
                        out.log.info(`The matched tab is ${err.page?.url.slice(0, 100)}, and these all tie to it:`);
                    }

                    out.log.info(err.candidates.map((c) => `    ${c}`).join("\n"));

                    const only = disambiguatingMatch(err.candidates);

                    if (only) {
                        out.log.info(
                            `  name one outright: ${suggest(["net-panel", "--port", String(port), "--match", only])}`
                        );
                    } else {
                        // Two candidates are the same string, so no substring separates
                        // them. Printing a --match command here would just reprint this error.
                        out.log.info(
                            `  --match cannot separate these: two share the same ${err.kind === "tab" ? "url" : "window title"}. Close one, then re-run.`
                        );
                        out.log.info(`  what is open: ${suggest(["targets", "--port", String(port), "--all"])}`);
                    }
                    process.exit(1);
                }

                if (!(err instanceof NoDevToolsTargetError)) {
                    throw err;
                }

                out.log.error(`${err.message} on port ${port}.`);

                if (err.page) {
                    out.log.info(
                        `The tab is open (${err.page.url.slice(0, 100)}) but has no DevTools window.\n  Open DevTools on it (Cmd+Opt+I / F12), switch to Network, tick "Preserve log", then re-run.`
                    );
                } else {
                    out.log.info(`No tab matched '${opts.match}'.`);
                }

                if (err.inspectorTitles.length > 0) {
                    out.log.info(`Open DevTools windows:\n${err.inspectorTitles.map((t) => `    ${t}`).join("\n")}`);
                }

                out.log.info(`  full target list: ${suggest(["targets", "--port", String(port), "--all"])}`);
                out.log.info(
                    `  the recorder buffer instead: ${suggest(["har", "--port", String(port), "--last", "30m"])}`
                );
                process.exit(1);
            }

            if (!pick.devtools.webSocketDebuggerUrl) {
                // /json/list omits the socket url for a target something else is
                // already debugging. Naming that beats `new WebSocket(undefined)`.
                out.log.error(`'${pick.devtools.title}' exposes no debugger socket, so its log cannot be read.`);
                out.log.info(
                    "  A target reports no webSocketDebuggerUrl while another client is attached to it. Close the other debugger (or the DevTools-on-DevTools window) and re-run."
                );
                process.exit(1);
            }

            if (!pick.exactSubject) {
                // Accepting the only prefix candidate keeps a truncated title working, but an
                // inspector on a SHORTER path belongs to a different tab. Saying so is what
                // stops this from being the silent wrong-log read the title rule exists to kill.
                out.log.warn(
                    `'${pick.devtools.title}' does not name ${pick.page?.url ?? opts.match} exactly; it is the only inspector that could belong to it, so it was used.`
                );
                out.log.info(
                    "  A long DevTools title is truncated, which is this same shape — but so is an inspector open on a shorter path of the same host. Check the inspector named in the output below."
                );
            }

            const page = new Page(new Conn(pick.devtools.webSocketDebuggerUrl), pick.devtools);
            let dump: ReturnType<typeof parsePanelDump>;

            try {
                dump = parsePanelDump(
                    await withDeadline(
                        page.evaluate(PANEL_DUMP_SCRIPT),
                        PANEL_READ_TIMEOUT_MS,
                        `the DevTools frontend did not answer within ${Math.round(PANEL_READ_TIMEOUT_MS / 1000)}s`
                    )
                );
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                out.log.error(`reading the panel NetworkLog failed: ${message}`);

                if (message.includes("did not answer within")) {
                    // The socket is open and the frontend is simply not answering, which
                    // an unbounded Runtime.evaluate would have spent the whole session on.
                    out.log.info(
                        `  '${pick.devtools.title}' held the socket open without replying. Its window is usually busy or mid-reload — click it, let it settle, then re-run.`
                    );
                } else if (/socket did not open|connection closed/i.test(message)) {
                    // The window was listed a moment ago and is gone now. Sending the
                    // reader after the module shape here would be a wrong-cause hint.
                    out.log.info(
                        `  The debugger socket for '${pick.devtools.title}' never carried a message — the window was closed between the target listing and the read.`
                    );
                } else {
                    out.log.info(
                        `  '${pick.devtools.title}' answered, but not as a DevTools frontend. The nested export is logs.NetworkLog.NetworkLog; a plain page has no such module.`
                    );
                }

                page.close();
                process.exit(1);
            }

            page.close();

            if (opts.fullUrls === true && !opts.out) {
                out.log.warn("--full-urls only reaches the -o HAR; printed urls are always cut to origin+pathname.");
            }

            const summary = summarizePanel(dump, {
                documentLimit: positiveNumber(opts.documents, DEFAULT_DOCUMENT_LIMIT, "--documents"),
            });

            if (opts.json) {
                out.result(summary);
            } else {
                printSummary(summary);
            }

            if (opts.out) {
                const har = panelDumpToHar(dump, { fullUrls: opts.fullUrls === true });
                const written = opts.fullUrls ? sanitizeHar(har) : har;
                await Bun.write(opts.out, SafeJSON.stringify(written, { strict: true }, 2));
                out.log.info(`${written.log.entries.length} entries -> ${opts.out}`);
                out.log.info(
                    "no headers, cookies or POST bodies are in this file — net-panel never collects them from the frontend."
                );
                out.log.info(`  analyze: tools har-analyzer load ${opts.out}`);
            }

            process.exit(0);
        });
}
