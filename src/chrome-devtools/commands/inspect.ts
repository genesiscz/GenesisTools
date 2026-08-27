/** cookies / rm-cookie / console / eval / nav / shot / grid / trace — page and browser inspection. */
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { browser, classifyEvalError, newTab } from "../lib/cdp.ts";
import { artifactPath } from "../lib/platform.ts";
import { attachTab, ignoreSigpipe, positiveNumber, resolvePort, suggest, withPage, withPort } from "./shared.ts";

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

                out.println(
                    `\n${cs.length} cookies. Duplicate name on different paths => longer path is sent FIRST (RFC 6265); servers taking the first value bind to the stale session.`
                );
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
            await b.deleteCookie(opts.name, opts.domain, opts.path);
            out.log.info(`deleted ${opts.name} ${opts.domain} ${opts.path}`);
            b.close();
            process.exit(0);
        });

    withPage(program.command("console"))
        .description(
            "dump console messages of a tab. Attaches FIRST, so --reload replays load-time messages (the MCP list_console_messages can never see those)."
        )
        .option("--reload", "reload the page once attached")
        .option("--wait <n>", "seconds to listen (default 5, or 8 with --reload)")
        .action(async (opts: { port?: string; match?: string; reload?: boolean; wait?: string }) => {
            const page = await attachTab(opts);
            const lines: string[] = [];
            page.onConsole((level, text) => lines.push(`[${level}] ${text}`));
            out.log.info(`attached to: ${page.target.url}`);

            if (opts.reload) {
                await page.reload();
            }

            await Bun.sleep(positiveNumber(opts.wait, opts.reload ? 8 : 5, "--wait") * 1000);
            out.println(
                lines.length
                    ? lines.join("\n")
                    : "<nothing logged in that window — use --reload to replay load-time messages>"
            );
            process.exit(0);
        });

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
        .action(async (fnOrExpr: string | undefined, opts: { port?: string; match?: string; file?: string }) => {
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
                const value = await page.evaluate(source);

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
        .description("navigate a tab, or open a new one with --new")
        .argument("<url>", "destination URL")
        .option("--new", "open a NEW tab instead of reusing one (cannot be combined with --match)")
        .action(async (url: string, opts: { port?: string; match?: string; new?: boolean }) => {
            if (opts.new) {
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
