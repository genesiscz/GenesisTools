/** open / restart / targets — getting a CDP endpoint to exist, on any platform. */
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { browserVersion, makeMatcher, targets } from "../lib/cdp.ts";
import { CdpLaunchError, launchCdpBrowser } from "../lib/launch.ts";
import { BROWSER_APPS, BROWSERS, browserById, listRunningBrowsers, quitBrowser } from "../lib/resolve-attach.ts";
import {
    formatVerification,
    isSafeProfileDirectory,
    QUIT_DEADLINE_MS,
    QUIT_NOTICE_EVERY_MS,
    resolveLastUsedProfile,
    restartSucceeded,
    slowQuitNote,
    verifyRestart,
} from "../lib/restart.ts";
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
    userDataDir?: string;
}

/** A persistent separate profile: logins survive between runs, unlike --fresh, and Chrome ≥136 accepts the flag there. */
/**
 * One persistent profile PER BROWSER: Chrome, Brave and Chromium cannot share a user-data-dir (profile lock,
 * mixed session state), so the suggested path carries the browser id.
 */
export function persistentProfileHint(browser: string): string {
    return `~/.genesis-tools/chrome-devtools/${browser}/profile`;
}

export function registerBrowse(program: Command): void {
    withPort(program.command("open"))
        .description(
            "launch a CDP-enabled browser (the flag is read at startup only; refuses if that app is already running)"
        )
        .argument("[url]", "url to open", "about:blank")
        .option("--browser <name>", BROWSER_IDS, "chrome")
        .option("--fresh", "throwaway profile — your own profile stays untouched (but you must log in again)")
        .option(
            "--user-data-dir <dir>",
            `persistent separate profile (logins survive between runs; Chrome ≥136 refuses the debug flag on its default profile, so this is the way to keep sessions). Use one directory per browser, e.g. ${persistentProfileHint("chrome")}. Keeps Chrome's local/private-network checks, unlike --fresh`
        )
        .option("--extension <dist-dir>", "load an unpacked extension (implies its own profile)")
        .action(async (url: string, opts: OpenOpts) => {
            const { id, name } = browserDefOf(opts.browser);
            const def = browserById(id);
            const port = portOf(opts);

            if (!def) {
                out.log.error(`unknown browser '${id}'. Valid: ${BROWSER_IDS}`);
                process.exit(1);
            }

            if (opts.fresh && opts.userDataDir) {
                out.log.error("--fresh and --user-data-dir contradict each other: one is throwaway, the other is not.");
                out.log.info("  Drop --fresh to reuse the directory, or drop --user-data-dir for a throwaway profile.");
                process.exit(1);
            }

            if (!opts.fresh && !opts.extension && !opts.userDataDir && listRunningBrowsers().includes(id)) {
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
                    userDataDir: opts.userDataDir,
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
        .option(
            "--profile-directory <dir>",
            "relaunch into this profile dir (default: the browser's own profile.last_used, which keeps the \"Who's using …?\" picker shut)"
        )
        .addHelpText(
            "after",
            `
A slow quit is NOT a failed quit. A page with a beforeunload handler makes the
browser ask the user to confirm before it closes, which can hold the process for
tens of seconds. This verb polls for real exit for ${Math.round(QUIT_DEADLINE_MS / 1000)}s and only then
mentions --force, because force-killing a browser that is already shutting down
cleanly is what costs you session restore.

On a multi-profile browser the relaunch would otherwise open the profile picker
("Who's using …?"). The profile is read from the browser's own Local State and
passed as --profile-directory, so no picker appears and no Accessibility grant
is needed. If one appears anyway it is reported with a dismissal command.

Every run ends with a verification block: whether the port answers CDP, how many
page targets exist, and whether a picker is still open.`
        )
        .action(async (url: string, opts: OpenOpts & { force?: boolean; profileDirectory?: string }) => {
            const { id, name } = browserDefOf(opts.browser);
            const def = browserById(id);
            const port = portOf(opts);

            if (!def) {
                out.log.error(`unknown browser '${id}'. Valid: ${BROWSER_IDS}`);
                process.exit(1);
            }

            if (opts.profileDirectory !== undefined && !isSafeProfileDirectory(opts.profileDirectory)) {
                out.log.error(
                    `--profile-directory '${opts.profileDirectory}' is not a plain profile directory name (e.g. Default, "Profile 1").`
                );
                process.exit(1);
            }

            const profile = opts.profileDirectory
                ? { directory: opts.profileDirectory, reason: null }
                : resolveLastUsedProfile({ browser: id });

            if (profile.directory) {
                out.log.info(`profile: ${profile.directory} (no picker will open)`);
            } else {
                out.log.info(
                    `profile: not resolved (${profile.reason}) — a multi-profile ${name} may show its picker after relaunch.`
                );
            }

            out.log.info(`quitting ${name} (tabs come back via session restore)...`);
            const quitStartedAt = Date.now();
            const q = await quitBrowser({
                app: name,
                browser: def,
                force: opts.force === true,
                // A single short check is what reported a healthy beforeunload quit
                // as a failure, and then recommended kill -KILL on it.
                timeoutMs: QUIT_DEADLINE_MS,
                noticeEveryMs: QUIT_NOTICE_EVERY_MS,
                onWaiting: (elapsedMs) => out.log.info(`  ${slowQuitNote(elapsedMs)}`),
            });

            if (!q.exited) {
                const waited = Math.round((Date.now() - quitStartedAt) / 1000);
                out.log.error(`${name} is STILL running ${waited}s after the quit request.`);

                if (q.usedForce) {
                    // kill -KILL already went out, so telling the operator to try --force
                    // would name the remedy they just used. Nothing here is an ordinary quit.
                    out.log.info(
                        "  kill -KILL was already sent and the process is still listed, which is not a quit problem — a process is normally unkillable only while stuck in the kernel."
                    );
                    out.log.info(`  see what is left: pgrep -fl '${name}'`);
                } else {
                    out.log.info(
                        "  Past this deadline a beforeunload prompt is probably waiting for a click. Look at the browser and answer it — that is the non-destructive fix."
                    );
                    out.log.info(
                        `  Only if there is no prompt: ${suggest(["restart", "--browser", id, "--port", String(port), "--force"])}   # kill -KILL, costs session restore`
                    );
                }

                process.exit(1);
            }

            let result: { browser: string; pages: number };
            try {
                result = await launchCdpBrowser({
                    port,
                    browser: id,
                    url,
                    profileDirectory: profile.directory ?? undefined,
                });
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
                    `  fallback, throwaway profile (log in again each time): ${suggest(["open", "--browser", id, "--port", String(port), "--fresh", url])}`
                );
                out.log.info(
                    `  fallback, persistent profile (logins kept between runs): ${suggest(["open", "--browser", id, "--port", String(port), "--user-data-dir", persistentProfileHint(id), url])}`
                );
                process.exit(1);
            }

            out.log.info(`up: ${result.browser} on ${port} (${result.pages} pages)`);

            // Read-only end-state check. Before this, proving a restart had worked
            // meant running curl /json/version and an AppleScript window walk by hand.
            const verification = await verifyRestart({ port, version: browserVersion, targets });
            for (const line of formatVerification(verification, { appName: name })) {
                out.log.info(line);
            }

            out.log.info(`  next: ${suggest(["attach", "--port", String(port)])}`);
            process.exit(restartSucceeded(verification) ? 0 : 1);
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
