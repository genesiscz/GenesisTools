/** open / restart / targets — getting a CDP endpoint to exist, on any platform. */
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { makeMatcher, targets } from "../lib/cdp.ts";
import { CdpLaunchError, launchCdpBrowser } from "../lib/launch.ts";
import { BROWSER_APPS, BROWSERS, browserById, listRunningBrowsers, quitBrowser } from "../lib/resolve-attach.ts";
import { portOf, resolvePort, suggest, withPort } from "./shared.ts";

/**
 * Strict: an unknown --browser value must ERROR, never fall back to Chrome —
 * a typo like `--browser bave` would otherwise quit the WRONG browser in
 * `restart` and cost the user their open tabs.
 */
function browserDefOf(raw: unknown): { id: string; name: string } {
    // Object.hasOwn: a plain index check would accept --browser toString via the prototype.
    if (raw !== undefined && (typeof raw !== "string" || !Object.hasOwn(BROWSER_APPS, raw))) {
        out.log.error(`unknown --browser '${String(raw)}'. Valid: ${BROWSER_IDS}`);
        process.exit(1);
    }

    const id = typeof raw === "string" ? raw : "chrome";

    return { id, name: BROWSER_APPS[id] };
}

const BROWSER_IDS = BROWSERS.map((b) => b.id).join("|");

function truncate(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

interface OpenOpts {
    port?: string;
    browser?: string;
    fresh?: boolean;
    extension?: string;
}

export function registerBrowse(program: Command): void {
    withPort(program.command("open"))
        .description(
            "launch a CDP-enabled browser (the flag is read at startup only; refuses if that app is already running)"
        )
        .argument("[url]", "url to open", "about:blank")
        .option("--browser <name>", BROWSER_IDS, "chrome")
        .option("--fresh", "throwaway profile — your own profile stays untouched (but you must log in again)")
        .option("--extension <dist-dir>", "load an unpacked extension (implies its own profile)")
        .action(async (url: string, opts: OpenOpts) => {
            const { id, name } = browserDefOf(opts.browser);
            const def = browserById(id);
            const port = portOf(opts);

            if (!def) {
                out.log.error(`unknown browser '${id}'. Valid: ${BROWSER_IDS}`);
                process.exit(1);
            }

            if (!opts.fresh && !opts.extension && listRunningBrowsers().includes(id)) {
                out.log.error(`${name} is already running. The debug flag cannot be added to a live process.`);
                out.log.info(`  ${suggest(["restart", "--browser", id, "--port", String(port)])}`);
                process.exit(1);
            }

            let up = false;
            try {
                const result = await launchCdpBrowser({
                    port,
                    browser: id,
                    url,
                    fresh: opts.fresh === true,
                    extension: opts.extension,
                });
                up = true;
                out.log.info(`up: ${result.browser} on ${port} (${result.pages} pages)`);
            } catch (err) {
                if (!(err instanceof CdpLaunchError)) {
                    throw err;
                }

                if (err.stage === "spawn") {
                    out.log.error(err.message);
                    process.exit(1);
                }

                out.log.info(
                    `launched but no CDP on ${port} yet. Do not raw-curl /json/version — re-run: ${suggest(["attach"])}`
                );
            }

            out.log.info(`  next: ${suggest(["attach", "--port", String(port)])}`);
            process.exit(up ? 0 : 1);
        });

    withPort(program.command("restart"))
        .description(
            "quit the app, wait until it is gone, relaunch with --remote-debugging-port. Costs open tabs (session restore usually brings them back) — ask the user first."
        )
        .argument("[url]", "url to open after relaunch", "about:blank")
        .option("--browser <name>", BROWSER_IDS, "chrome")
        .option("--force", "if quit sticks, force-kill (ask the user first)")
        .action(async (url: string, opts: OpenOpts & { force?: boolean }) => {
            const { id, name } = browserDefOf(opts.browser);
            const def = browserById(id);
            const port = portOf(opts);

            if (!def) {
                out.log.error(`unknown browser '${id}'. Valid: ${BROWSER_IDS}`);
                process.exit(1);
            }

            out.log.info(`quitting ${name} (tabs come back via session restore)...`);
            const q = await quitBrowser({ app: name, browser: def, force: opts.force === true });

            if (!q.exited) {
                out.log.error(`${name} is still running. Re-run with --force to force-kill.`);
                process.exit(1);
            }

            let result: { browser: string; pages: number };
            try {
                result = await launchCdpBrowser({ port, browser: id, url });
            } catch (err) {
                if (!(err instanceof CdpLaunchError)) {
                    throw err;
                }

                out.log.error(
                    err.stage === "spawn"
                        ? err.message
                        : `relaunched but no CDP on ${port}. Chrome ≥136 refuses the flag on the DEFAULT profile dir (anti-automation).`
                );
                out.log.info(
                    `  fallback with a separate profile: ${suggest(["open", "--browser", id, "--port", String(port), "--fresh", url])}`
                );
                process.exit(1);
            }

            out.log.info(`up: ${result.browser} on ${port} (${result.pages} pages)`);
            out.log.info(`  next: ${suggest(["attach", "--port", String(port)])}`);
            process.exit(0);
        });

    withPort(program.command("targets"))
        .description(
            "list the endpoint's tabs — one line per target (id, title, url). --json for the same list as JSON."
        )
        .option("--match <substr>", "only targets whose url or title contains this substring, or /regex/")
        .option("--all", "include non-page targets (workers, iframes, extension pages)")
        .option("--json", "the listed targets as JSON — /json/list entries, after --all and --match")
        .action(async (opts: { port?: string; match?: string; all?: boolean; json?: boolean }) => {
            const port = await resolvePort(opts);
            const all = await targets(port);
            const scoped = opts.all ? all : all.filter((t) => t.type === "page");
            const matches = opts.match ? makeMatcher(opts.match) : null;
            const list = matches ? scoped.filter((t) => matches(t.url) || matches(t.title ?? "")) : scoped;

            if (opts.json) {
                out.result(list);
                process.exit(0);
            }

            // A 40KB single-line JSON blob for 25 tabs is not readable output:
            // finding one tab meant saving it to a file and running rg over it.
            for (const t of list) {
                out.println(`${t.id}  ${truncate(t.title ?? "", 46).padEnd(46)}  ${t.url}`);
            }

            out.println(
                `\n${list.length} of ${scoped.length} ${opts.all ? "targets" : "page targets"} on ${port}${opts.match ? ` matching '${opts.match}'` : ""}.`
            );
            process.exit(list.length ? 0 : 1);
        });
}
