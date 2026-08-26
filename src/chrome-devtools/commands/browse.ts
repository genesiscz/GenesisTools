/** open / restart / targets — getting a CDP endpoint to exist, on any platform. */
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { targets } from "../lib/cdp.ts";
import {
    BROWSER_APPS,
    BROWSERS,
    browserById,
    freshProfileDir,
    launchBrowser,
    listRunningBrowsers,
    quitBrowser,
    waitForCdp,
} from "../lib/resolve-attach.ts";
import { portOf, probe, refuseIfAmbiguous, suggest, withPort } from "./shared.ts";

/** Chromium launch flags. Exported for tests: the --user-data-dir rule is what keeps `open` off the real profile. */
export function launchArgs(port: number, opts: { fresh?: boolean; extension?: string }): string[] {
    const args = [`--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check"];

    if (opts.fresh || opts.extension) {
        args.push(`--user-data-dir=${freshProfileDir(port)}`);
        // Local/private-network access checks block CDP-driven fetches to dev
        // servers, so throwaway profiles disable them. The user's REAL profile
        // (plain open / restart) keeps every protection — a normal browsing
        // session must never run security-downgraded.
        args.push("--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks");
    }

    if (opts.extension) {
        args.push(`--load-extension=${opts.extension}`, `--disable-extensions-except=${opts.extension}`);
    }

    return args;
}

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

            const launch = launchBrowser({
                browser: def,
                args: launchArgs(port, { fresh: opts.fresh === true, extension: opts.extension }),
                url,
            });

            if (!launch.ok) {
                out.log.error(launch.message);
                process.exit(1);
            }

            const up = await waitForCdp({ port, probe, timeoutMs: 20000 });
            const result = up ? await probe(port) : null;
            out.log.info(
                result
                    ? `up: ${result.browser} on ${port} (${result.pages.length} pages)`
                    : `launched but no CDP on ${port} yet. Do not raw-curl /json/version — re-run: ${suggest(["attach"])}`
            );
            out.log.info(`  next: ${suggest(["attach", "--port", String(port)])}`);
            process.exit(result ? 0 : 1);
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

            const launch = launchBrowser({ browser: def, args: launchArgs(port, {}), url });
            if (!launch.ok) {
                out.log.error(launch.message);
                process.exit(1);
            }

            const up = await waitForCdp({ port, probe, timeoutMs: 20000 });
            const result = up ? await probe(port) : null;

            if (!result) {
                out.log.error(
                    `relaunched but no CDP on ${port}. Chrome ≥136 refuses the flag on the DEFAULT profile dir (anti-automation).`
                );
                out.log.info(
                    `  fallback with a separate profile: ${suggest(["open", "--browser", id, "--port", String(port), "--fresh", url])}`
                );
                process.exit(1);
            }

            out.log.info(`up: ${result.browser} on ${port} (${result.pages.length} pages)`);
            out.log.info(`  next: ${suggest(["attach", "--port", String(port)])}`);
            process.exit(0);
        });

    withPort(program.command("targets"))
        .description("raw /json/list of the endpoint (every tab, its targetId and URL)")
        .action(async (opts: { port?: string }) => {
            await refuseIfAmbiguous();
            out.result(await targets(portOf(opts)));
            process.exit(0);
        });
}
