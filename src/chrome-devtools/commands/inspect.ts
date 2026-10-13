/** cookies / rm-cookie / console / eval / nav / shot / grid / trace — page and browser inspection. */
import { navigateSpa, type PageCondition, waitForPage } from "@genesiscz/utils/chrome-devtools/spa";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import {
    browser,
    classifyEvalError,
    consoleLevelSummary,
    cookiesSummaryLine,
    newTab,
    nextLoadEvent,
} from "../lib/cdp.ts";
import { cdpLikeOf } from "../lib/cdp-like-adapter.ts";
import { artifactPath } from "../lib/platform.ts";
import { attachTab, ignoreSigpipe, positiveNumber, resolvePort, suggest, withPage, withPort } from "./shared.ts";

type NavOptions = {
    port?: string;
    match?: string;
    new?: boolean;
    spa?: boolean;
    waitFor?: string;
    waitText?: string;
    timeout: string;
};

function describeCondition(condition: PageCondition): string {
    const parts: string[] = [];
    if (condition.selector) {
        parts.push(`'${condition.selector}'`);
    }

    if (condition.text) {
        parts.push(`text '${condition.text}'`);
    }

    return parts.join(" with ");
}

export function registerInspect(program: Command): void {
    withPort(program.command("cookies"))
        .description("every cookie incl. httpOnly, across all domains — what page JS can never see")
        .option("--domain <substr>", "only cookies whose domain contains this")
        .option("--json", "machine-readable, for diffing two browsers")
        .action(async (opts: { port?: string; domain?: string; json?: boolean }) => {
            const b = await browser(await resolvePort(opts));
            const cs = await b.cookies(opts.domain);

            if (opts.json) {
                out.result(
                    cs.map((c) => ({
                        name: c.name,
                        domain: c.domain,
                        path: c.path,
                        httpOnly: c.httpOnly,
                        secure: c.secure,
                        sameSite: c.sameSite,
                        session: c.expires === -1,
                        len: c.value.length,
                    }))
                );
            } else {
                const seen = new Map<string, number>();
                for (const c of cs) {
                    seen.set(c.name, (seen.get(c.name) ?? 0) + 1);
                }

                for (const c of cs.sort((a, z) => a.name.localeCompare(z.name))) {
                    const dup = (seen.get(c.name) ?? 0) > 1 ? "  <-- DUPLICATE NAME" : "";
                    out.println(
                        `${c.name.padEnd(38)} ${c.domain.padEnd(22)} path=${(c.path ?? "/").padEnd(10)} httpOnly=${c.httpOnly ? "y" : "n"} session=${c.expires === -1 ? "y" : "n"} len=${c.value.length}${dup}`
                    );
                }

                out.println(`\n${cookiesSummaryLine(cs.length)}`);
            }

            b.close();
            process.exit(0);
        });

    withPort(program.command("rm-cookie"))
        .description(
            "delete ONE cookie by name+domain+path — the surgical confirmation step. Never 'clear site data' (it destroys the evidence and the user's logins)."
        )
        .requiredOption("--name <name>", "cookie name")
        .requiredOption("--domain <domain>", "cookie domain, exactly as listed by 'cookies'")
        .option("--path <path>", "cookie path", "/")
        .action(async (opts: { port?: string; name: string; domain: string; path: string }) => {
            const b = await browser(await resolvePort(opts));
            let deleted = false;

            // The delete throws when a cookie survives the write. Without this the open CDP
            // socket kept the process alive after commander printed the error.
            try {
                deleted = await b.deleteCookie(opts.name, opts.domain, opts.path);
            } catch (err) {
                out.log.error(err instanceof Error ? err.message : String(err));
                b.close();
                process.exit(1);
            }

            if (deleted) {
                out.log.info(`deleted ${opts.name} ${opts.domain} ${opts.path}`);
            } else {
                out.log.warn(`no cookie ${opts.name} ${opts.domain} ${opts.path}; list them with 'cookies'`);
            }

            b.close();
            process.exit(deleted ? 0 : 1);
        });

    withPage(program.command("console"))
        .description(
            "dump a tab's console: what it already logged (Chrome keeps those and replays them when we attach) plus what it logs while we listen. --reload adds a fresh page load."
        )
        .option("--reload", "reload the page once attached; a '── reload ──' line separates the earlier messages")
        .option("--wait <n>", "seconds to listen (default 5, or 8 with --reload)")
        .addHelpText(
            "after",
            `
Use it when a page misbehaves and you want its own errors, without opening DevTools.
Messages logged BEFORE you attached are included: the listener exists before Runtime.enable,
which replays them. The last line counts them by level.

Examples:
  ${suggest(["console", "--match", "localhost:3000"])}
  ${suggest(["console", "--match", "app.example.com", "--reload", "--wait", "12"])}
  ${suggest(["console", "--port", "9222", "--match", "/localhost:(3000|5173)/"])}`
        )
        .action(async (opts: { port?: string; match?: string; reload?: boolean; wait?: string }) => {
            const lines: string[] = [];
            const levels: string[] = [];
            const page = await attachTab(opts, {
                beforeEnable: (connected) =>
                    connected.onConsole((level, text) => {
                        lines.push(`[${level}] ${text}`);
                        levels.push(level);
                    }),
            });
            out.log.info(`attached to: ${page.target.url}`);

            if (opts.reload) {
                lines.push("── reload ──");
                await page.reload();
            }

            await Bun.sleep(positiveNumber(opts.wait, opts.reload ? 8 : 5, "--wait") * 1000);
            out.println(levels.length ? lines.join("\n") : "<nothing logged, before or during that window>");
            out.log.info(consoleLevelSummary(levels));
            process.exit(0);
        });

    type EvalOptions = { port?: string; match?: string; file?: string; timeout?: string };

    withPage(program.command("eval"))
        .description("run JS in the page and print the result as JSON")
        .argument(
            "[fnOrExpr]",
            "arrow function or expression, e.g. '() => ({url: location.href, ls: {...localStorage}})'"
        )
        .option(
            "--file <path>",
            "read the function/expression from a file — dodges shell quoting (and hooks that block inline eval strings)"
        )
        .option("--timeout <seconds>", "how long the expression (and a promise it returns) may run", "30")
        .action(async (fnOrExpr: string | undefined, opts: EvalOptions) => {
            const timeoutMs = positiveNumber(opts.timeout, 30, "--timeout") * 1000;
            let source = fnOrExpr;
            if (opts.file) {
                const f = Bun.file(opts.file);
                if (!(await f.exists())) {
                    out.log.error(`--file ${opts.file} does not exist.`);
                    process.exit(1);
                }

                source = await f.text();
            }

            if (!source?.trim()) {
                out.log.error("eval needs an expression argument or --file <path>.");
                out.log.info(`  e.g. ${suggest(["eval", "() => location.href"])}`);
                out.log.info(`  or:  ${suggest(["eval", "--file", artifactPath("probe.js")])}`);
                process.exit(1);
            }

            const page = await attachTab(opts);

            try {
                const value = await page.evaluate(source, { timeoutMs });

                // undefined is a normal result (location.reload(), a void call).
                // Say so on stderr; stdout still gets valid JSON.
                if (value === undefined) {
                    out.log.info("the expression returned no value (undefined); stdout gets null");
                }

                out.result(value);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);

                // location.reload() / location.href = … tear the execution
                // context down before the eval can answer. That is the script
                // doing its job, not a failure, so say so and exit 0.
                if (classifyEvalError(message) === "navigated") {
                    out.log.info("page navigated; eval context gone before it returned a value");
                    process.exit(0);
                }

                out.log.error(message);
                process.exit(1);
            }

            process.exit(0);
        });

    withPage(program.command("nav"))
        .description("navigate a tab, open a new one with --new, or move a single-page app in place with --spa")
        .argument(
            "<url>",
            "destination URL; with --spa the full path as the address bar shows it (include the app's base, e.g. /app/billing) or a same-origin URL"
        )
        .option("--new", "open a NEW tab instead of reusing one (cannot be combined with --match)")
        .option(
            "--spa",
            "in-app navigation: history.pushState + popstate, no reload, so app state and caches survive (same origin only)"
        )
        .option("--wait-for <selector>", "then wait until this CSS selector is in the page")
        .option("--wait-text <text>", "then wait until the page (or the --wait-for element) contains this text")
        .option("--timeout <seconds>", "deadline for --wait-for / --wait-text", "15")
        .addHelpText(
            "after",
            `
Use --spa to reach a route the way a click would: a full load resets the app's in-memory state
(query caches, stores), --spa keeps it. Give the full path, base included: an app served under /app/
needs /app/billing, and /billing leaves it on a blank page (a warning says so when the first path
segment changes). It works with routers that listen to popstate (React Router,
TanStack Router, most others). Exit code 1 when --wait-for / --wait-text did not hold in time.

Examples:
  ${suggest(["nav", "https://app.example.com/login", "--match", "app.example.com"])}
  ${suggest(["nav", "/billing", "--spa", "--match", "localhost:3000", "--wait-text", "Billing"])}
  ${suggest(["nav", "/settings", "--spa", "--match", "app.example.com", "--wait-for", "h1", "--timeout", "5"])}
  ${suggest(["nav", "https://example.com", "--new", "--port", "9222"])}`
        )
        .action(async (url: string, opts: NavOptions) => {
            const timeoutMs = positiveNumber(opts.timeout, 15, "--timeout") * 1000;
            const condition: PageCondition | undefined =
                opts.waitFor || opts.waitText ? { selector: opts.waitFor, text: opts.waitText } : undefined;

            if (opts.new) {
                if (opts.spa) {
                    out.log.error(
                        "--spa moves an EXISTING app in place, so it cannot open a new tab. Use one or the other."
                    );
                    process.exit(1);
                }

                if (condition) {
                    out.log.error("--wait-for / --wait-text need an attached tab; --new only opens one.");
                    out.log.info(
                        `  then: ${suggest(["nav", url, "--match", "<new tab url>", "--wait-for", "<selector>"])}`
                    );
                    process.exit(1);
                }

                if (opts.match) {
                    out.log.error("--new opens a fresh tab, so --match has nothing to pick. Use one or the other.");
                    process.exit(1);
                }

                const port = await resolvePort(opts);
                const target = await newTab(port, url).catch((err: unknown) => {
                    out.log.error(err instanceof Error ? err.message : String(err));
                    process.exit(1);
                });
                out.log.info(`new tab ${target.id} on ${port}: ${target.url || url}`);
                process.exit(0);
            }

            const page = await attachTab(opts);
            const before = page.target.url;

            if (!opts.match) {
                out.log.info("no --match given: acting on the most recently active tab");
            }

            if (opts.spa) {
                try {
                    const moved = await navigateSpa(cdpLikeOf(page), { path: url, waitFor: condition, timeoutMs });
                    out.log.info(`tab ${page.target.id}: ${moved.from}\n         -> ${moved.to} (in-app, no reload)`);
                    const firstSegment = (path: string) => path.split(/[?#]/)[0]?.split("/")[1] ?? "";
                    // A changed first segment is also every normal top-level move (/dashboard -> /billing), so it
                    // is only a likely cause when the wait condition failed; with no condition it is a note.
                    const conditionFailed = Boolean(condition && moved.settled && !moved.settled.ok);
                    if (firstSegment(moved.from) !== firstSegment(moved.to) && (!condition || conditionFailed)) {
                        const hint = `the first path segment changed (/${firstSegment(moved.from)}/ -> /${firstSegment(moved.to)}/). If the app lives under /${firstSegment(moved.from)}/, include it: /${firstSegment(moved.from)}${moved.to}`;
                        if (conditionFailed) {
                            out.log.warn(hint);
                        } else {
                            out.log.info(hint);
                        }
                    }

                    if (condition && moved.settled) {
                        if (!moved.settled.ok) {
                            out.log.error(`${describeCondition(condition)} did not show within ${timeoutMs / 1000}s.`);
                            process.exit(1);
                        }

                        out.log.info(`${describeCondition(condition)} showed after ${Math.round(moved.settled.ms)} ms`);
                    }
                } catch (err) {
                    // The in-page throw carries its page-side stack; the first line is the reason.
                    const reason = (err instanceof Error ? err.message : String(err)).split("\n")[0];
                    out.log.error(reason);

                    if (reason.includes("needs a real navigation")) {
                        out.log.info(
                            `  another origin needs a real load: ${suggest(["nav", url, "--match", opts.match ?? "<substr>"])}`
                        );
                    }

                    process.exit(1);
                }

                process.exit(0);
            }

            if (condition) {
                const loaded = nextLoadEvent(page, timeoutMs);
                await page.navigate(url);

                if (!(await loaded)) {
                    out.log.error(`the page did not finish loading within ${timeoutMs / 1000}s.`);
                    process.exit(1);
                }

                const settled = await waitForPage(cdpLikeOf(page), condition, timeoutMs).catch((err: unknown) => {
                    out.log.error(
                        `waiting for ${describeCondition(condition)} failed: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`
                    );
                    process.exit(1);
                });
                const after = await page.evaluate("location.href").catch(() => url);
                out.log.info(`tab ${page.target.id}: ${before}\n         -> ${String(after)}`);

                if (!settled.ok) {
                    out.log.error(`${describeCondition(condition)} did not show within ${timeoutMs / 1000}s.`);
                    process.exit(1);
                }

                out.log.info(`${describeCondition(condition)} showed after ${Math.round(settled.ms)} ms`);
                process.exit(0);
            }

            await page.navigate(url);
            await Bun.sleep(2500);
            // page.target is the /json/list snapshot taken at attach time, so
            // printing it after a navigate reported the tab's OLD url — which
            // read as "nav clobbered some unrelated tab". Ask the tab itself.
            const after = await page.evaluate("location.href").catch(() => url);
            out.log.info(`tab ${page.target.id}: ${before}\n         -> ${String(after)}`);
            process.exit(0);
        });

    withPage(program.command("shot"))
        .description("screenshot the tab")
        .argument("[path]", "output PNG", artifactPath("shot.png"))
        .option("--full", "capture beyond the viewport")
        .action(async (path: string, opts: { port?: string; match?: string; full?: boolean }) => {
            const page = await attachTab(opts);
            out.println(await page.screenshot(path, opts.full === true));
            process.exit(0);
        });

    withPort(program.command("grid"))
        .description(
            "screenshot with a pixel-coordinate grid burned in — read the label, click the pixel (for pages where AX-tree tools see nothing). Needs ImageMagick."
        )
        .argument("[path]", "output PNG", artifactPath("grid.png"))
        .option("--region <x,y,w,h>", "crop before gridding")
        .option("--step <n>", "grid spacing in px", "60")
        .option("--full", "capture beyond the viewport")
        .action(async (path: string, opts: { port?: string; region?: string; step: string; full?: boolean }) => {
            const port = await resolvePort(opts);
            const { captureFrameGrid } = await import("../lib/frame-grid.ts");
            out.println(
                await captureFrameGrid({
                    outPath: path,
                    port,
                    region: opts.region,
                    gridStep: positiveNumber(opts.step, 60, "--step"),
                    fullPage: opts.full === true,
                })
            );
            process.exit(0);
        });

    withPage(program.command("trace"))
        .description(
            "quick one-liner: record the document + redirect chain (Location and Set-Cookie per hop) of ONE tab to a file. For multi-tab or channels, use record + follow."
        )
        .option("--seconds <n>", "how long to record", "90")
        .option("--out <file>", "log path", artifactPath("cdp-trace.log"))
        .action(async (opts: { port?: string; match?: string; seconds: string; out: string }) => {
            ignoreSigpipe();
            const secs = positiveNumber(opts.seconds, 90, "--seconds");
            const match = opts.match;
            const page = await attachTab(opts);
            out.log.info(`tracing ${page.target.url.slice(0, 90)} for ${secs}s (match=${match ?? "*"}) -> ${opts.out}`);
            const events = page.recordNetwork(match ? (u) => u.includes(match) : undefined);
            const lines: string[] = [];
            const t0 = Date.now();

            const timer = setInterval(() => {
                while (events.length) {
                    const e = events.shift();
                    if (!e) {
                        break;
                    }

                    const ts = ((Date.now() - t0) / 1000).toFixed(2).padStart(7);
                    let line = "";

                    if (e.kind === "redirect") {
                        const cookies =
                            Array.isArray(e.setCookie) && e.setCookie.length
                                ? `\n         set-cookie: ${e.setCookie.join(" | ")}`
                                : "";
                        line = `${ts} REDIR ${e.status} ${e.from}\n         -> ${e.location}${cookies}`;
                    } else if (e.kind === "request" && e.type === "Document") {
                        line = `${ts} DOC   ${e.method} ${e.url}`;
                    } else if (e.kind === "nav") {
                        line = `${ts} NAV   ${e.url}`;
                    } else if (e.kind === "failed") {
                        line = `${ts} FAIL  ${e.error} (${e.requestId})`;
                    } else {
                        continue;
                    }

                    lines.push(line);
                    out.println(line);
                }
            }, 250);

            setTimeout(async () => {
                clearInterval(timer);
                await Bun.write(opts.out, lines.join("\n"));
                out.log.info(`DONE ${lines.length} lines -> ${opts.out}`);
                out.log.info(
                    `retroactive alternative next time: ${suggest(["attach"])} then ${suggest(["har", "--last", "10m"])}`
                );
                process.exit(0);
            }, secs * 1000);
        });
}
