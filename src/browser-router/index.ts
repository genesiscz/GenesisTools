#!/usr/bin/env bun

import { configFile } from "@genesiscz/utils/browser-router/config";
import { tokenLink } from "@genesiscz/utils/browser-router/links";
import { presets } from "@genesiscz/utils/browser-router/presets";
import { RouteError, route } from "@genesiscz/utils/browser-router/route";
import { routerStatus } from "@genesiscz/utils/browser-router/status";
import { mintBundleToken, withTokenLock } from "@genesiscz/utils/browser-router/tokens";
import { runTool } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import {
    deleteRoute,
    enablePreset,
    ensureBuiltinRoutes,
    loadConfig,
    type RouteFlags,
    routeFromFlags,
    upsertRoute,
} from "./lib/config";
import { ensureRegisteredPort, parsePort } from "./lib/ensure";
import { defaultBrowserStatus, installRouterApp, restorePreviousBrowser } from "./lib/install";
import { launchOpen, openMintedLink, openUrl } from "./lib/launch";
import { collectLinks, convertMarkdown } from "./lib/links";
import {
    bundleLink,
    bundleNames,
    bundleUrls,
    checkBundleUrls,
    confirmDialog,
    openBundle,
    saveBundle,
    TAB_CAP,
} from "./lib/tabs";

const program = new Command();

program
    .name("browser-router")
    .description("Rewrites chosen http(s) links on this Mac and forwards the rest to the default browser.");

program
    .command("install")
    .description("Build GenesisTools.app, write the default config if needed, and make it the http(s) handler")
    .action(async () => {
        try {
            const installed = await installRouterApp();
            out.println(`Installed ${installed.app}`);
            out.println(`Signed with ${installed.signedWith === "-" ? "an ad-hoc signature" : installed.signedWith}`);
            out.println(defaultBrowserStatus());
        } catch (error) {
            fail(error);
        }
    });

program
    .command("uninstall")
    .description("Give http(s) back to the browser recorded before GenesisTools took it. Leaves the app in place.")
    .action(() => {
        try {
            out.println(restorePreviousBrowser());
        } catch (error) {
            fail(error);
        }
    });

program
    .command("status")
    .description("Show the config path and which app currently handles https")
    .option("--json", "Print installed, defaultHandler and the enabled presets as JSON (fast; skills call this)")
    .action(async (options: { json?: boolean }) => {
        if (options.json) {
            out.result(routerStatus());
            return;
        }

        await printStatus();
    });

const tabs = program.command("tabs").description("Many links, one click: named bundles and minted bundle links");

tabs.command("save")
    .description("Save a named bundle and print its link, https://genesis.tools/tabs/<name>")
    .argument("<name>", "A letter or digit, then letters, numbers, _ or -")
    .argument("[urls...]")
    .option("--from-md <file>", "Also take every http(s) link in this markdown file (- for stdin)")
    .action(async (name: string, urls: string[], options: { fromMd?: string }) => {
        try {
            const all = await bundleInput(urls, options.fromMd);
            await saveBundle(name, all);
            out.println(bundleLink(name));
            logger.debug({ name, links: all.length }, "browser-router: saved a tab bundle");
        } catch (error) {
            fail(error);
        }
    });

tabs.command("mint")
    .description("Print one minted link that opens every URL. It works --uses times (default 1).")
    .argument("[urls...]")
    .option("--from-md <file>", "Also take every http(s) link in this markdown file (- for stdin)")
    .option("--uses <count>", "How many clicks the link survives", "1")
    .action(async (urls: string[], options: { fromMd?: string; uses: string }) => {
        try {
            const all = await bundleInput(urls, options.fromMd);
            const id = await withTokenLock(() => mintBundleToken(all, Number(options.uses)));
            out.println(tokenLink(id));
            logger.debug({ links: all.length, uses: options.uses }, "browser-router: minted a tab bundle");
        } catch (error) {
            fail(error);
        }
    });

tabs.command("open")
    .description(`Open a saved bundle. GenesisTools.app runs this on a click. Above ${TAB_CAP} links it asks first.`)
    .argument("<name>")
    .action(async (name: string) => {
        try {
            const plan = await openBundle(bundleUrls(name), await requiredConfig(), {
                open: launchOpen,
                confirm: confirmDialog,
            });
            const opened = plan.windows.reduce((sum, window) => sum + window.urls.length, 0) + plan.routed.length;
            out.println(`Opened ${opened} of ${opened + plan.skipped.length} links`);

            for (const skipped of plan.skipped) {
                out.println(`skipped ${skipped.url}: ${skipped.reason}`);
            }
        } catch (error) {
            fail(error);
        }
    });

tabs.command("list")
    .description("List the saved bundles")
    .action(() => {
        try {
            const names = bundleNames();

            if (names.length === 0) {
                out.printlnErr("No saved bundles. Save one: tools browser-router tabs save <name> <urls...>");
                return;
            }

            for (const name of names) {
                out.println(`${name}  ${bundleUrls(name).length} links  ${bundleLink(name)}`);
            }
        } catch (error) {
            fail(error);
        }
    });

async function bundleInput(urls: string[], fromMd: string | undefined): Promise<string[]> {
    if (!fromMd) {
        return checkBundleUrls(urls);
    }

    const text = fromMd === "-" ? await Bun.stdin.text() : await Bun.file(fromMd).text();
    return checkBundleUrls([...new Set([...urls, ...collectLinks(text)])]);
}

program
    .command("ensure")
    .description("Start the registered server on a port if it is not already listening")
    .argument("<port>")
    .action(async (portText: string) => {
        const port = parsePort(portText);

        if (port === null) {
            out.error(`port must be a whole number from 1 to 65535, got ${portText}`);
            process.exitCode = 1;
            return;
        }

        const result = await ensureRegisteredPort(port);

        if (!result.ok) {
            out.error(result.message);
            process.exitCode = result.code;
            return;
        }

        out.println(result.started ? `started ${result.name}` : `${result.name} is up`);
    });

const presetsCommand = program
    .command("presets")
    .description("Show built-in routes. A preset is hidden when its app is not installed.")
    .action(() => {
        for (const preset of presets()) {
            const state = preset.installed ? "on " : preset.optIn && preset.available ? "opt" : "off";
            out.println(`${state}  ${preset.id}  ${preset.title}`);
        }

        out.println("opt = opt-in; switch it on with: tools browser-router presets enable <id>");
    });

presetsCommand
    .command("enable")
    .description("Write a preset's routes into the config (the way to switch on an opt-in preset such as decide)")
    .argument("<id>")
    .action(async (id: string) => {
        try {
            const saved = await enablePreset(id);
            out.println(`Enabled ${id}: ${saved.routes.filter((rule) => rule.preset === id).length} route(s)`);
        } catch (error) {
            fail(error);
        }
    });

program
    .command("routes")
    .description("List the saved routes")
    .action(async () => {
        const config = await loadConfig();

        if (!config) {
            out.println(`No config yet. ${configFile()}`);
            return;
        }

        out.println(SafeJSON.stringify(config.routes, null, 2));
    });

program
    .command("links")
    .description("Rewrite local links in markdown so a click goes through GenesisTools.app")
    .option("--convert <file>", "Markdown file, or - for stdin")
    .option("--uses <count>", "Mint each local link as a token that works this many times. Omit for a stable link.")
    .action(async (options: { convert?: string; uses?: string }) => {
        if (!options.convert) {
            fail(new Error("pass --convert <file>"));
        }

        try {
            const saved = await ensureBuiltinRoutes();
            const uses = options.uses === undefined ? undefined : Number(options.uses);
            const text = options.convert === "-" ? await Bun.stdin.text() : await Bun.file(options.convert).text();
            // Minting writes tokens.json, so it runs under the token lock.
            const converted =
                uses === undefined
                    ? convertMarkdown(text, uses, saved)
                    : await withTokenLock(() => convertMarkdown(text, uses, saved));
            out.print(converted);
        } catch (error) {
            fail(error);
        }
    });

program
    .command("route")
    .description("Save a route. The pattern is matched against the whole URL.")
    .argument("<pattern>", "Regular expression. Anchors are added when you omit them.")
    .option("--name <text>", "Headline on this route's card, e.g. 'Open mail'. Default: the command in words.")
    .option("--route-to <template>", "Rewrite to this URL. $1 is the first capture, $$ is a dollar.")
    .option("--run <program>", "Run this program. Arguments come from --arg. Not a shell.")
    .option("--tool <name>", "Record a GenesisTools tool. The helper does not run it yet.")
    .option(
        "--arg <template>",
        "Argument for --run or --tool. $1 is a capture, {qty} a query value, {ids*} splits on commas.",
        collect,
        [] as string[]
    )
    .option("--open <url>", "After a successful --run, open this URL in the default browser.")
    .option("--notify <text>", "After a successful --run, show this notification.")
    .option("--touch-id", "Require Touch ID or the Mac password before this command runs, for every parameter value.")
    .option("--no-toast", "Do not show the center card for this route")
    .option("--toast-seconds <seconds>", "How long this route's card stays before it fades")
    .option("--toast-title <text>", "Replace Opening / Running on this route's card")
    .option("--approval <mode>", "ask (dialog) or allow. Default ask.", "ask")
    .option("--delete", "Remove the route with this pattern")
    .action(async (pattern: string, flags: RouteFlags) => {
        try {
            if (flags.delete) {
                await deleteRoute(pattern);
                out.println(`Removed ${pattern}`);
                return;
            }

            const saved = await upsertRoute(routeFromFlags(pattern, flags));
            out.println(SafeJSON.stringify(saved.routes.at(-1), null, 2));
        } catch (error) {
            fail(error);
        }
    });

program
    .command("explain")
    .description("Print what a click on this URL would do")
    .argument("<url>")
    .option("--json", "Print the decision as JSON")
    .action(async (url: string, options: { json?: boolean }) => {
        try {
            const decision = route(url, await requiredConfig());

            if (options.json) {
                out.result(decision);
                return;
            }

            out.println(`${decision.kind} via ${decision.via}`);
            out.println(decision.url);

            if (decision.kind === "tool") {
                out.println(`tools ${decision.tool} ${decision.args.join(" ")} (${decision.approval}, not run)`);
                return;
            }

            if (decision.kind === "run") {
                out.println(decision.argv.join(" "));
                out.println(decision.needsApproval ? "approval: ask" : "approval: allow");
                if (decision.notify) {
                    out.println(`notify: ${decision.notify}`);
                }
                if (decision.browserArguments.length > 0) {
                    out.println(decision.browserArguments.join(" "));
                }
                return;
            }

            out.println(decision.openArguments.join(" ") || "(swallowed)");
        } catch (error) {
            fail(error);
        }
    });

program
    .command("open")
    .description("Apply the routes to a URL and open the result")
    .argument("<url>")
    .action(async (url: string) => {
        try {
            await openUrl(url, await requiredConfig());
        } catch (error) {
            fail(error);
        }
    });

const token = program.command("token").description("Minted one-use links (links --convert --uses)");

token
    .command("open")
    .description("Spend one use of a minted link and act on its URL. GenesisTools.app runs this on a click.")
    .argument("<id>", "The id after /t/ in https://genesis.tools/t/<id>")
    .action(async (id: string) => {
        try {
            await openMintedLink(id, await requiredConfig());
        } catch (error) {
            fail(error);
        }
    });

function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
}

async function requiredConfig() {
    const config = await loadConfig();

    if (!config) {
        throw new RouteError(`no config at ${configFile()}. Run: tools browser-router install`);
    }

    return config;
}

async function printStatus(): Promise<void> {
    out.println(`config=${configFile()}`);
    out.println(defaultBrowserStatus());
    const config = await loadConfig();
    out.println(`routes=${config?.routes.length ?? 0}`);

    for (const preset of routerStatus({ config }).presets) {
        if (preset.drift.length === 0) {
            continue;
        }

        out.println(`drift ${preset.id}: ${preset.drift.join("; ")}`);
        out.println(preset.fix ? `  fix: ${preset.fix}` : `  needs: ${preset.missing?.join(", ")}`);
    }
}

function fail(error: unknown): never {
    const message = error instanceof Error ? error.message : String(error);
    // The message is printed once below; the log file keeps the stack.
    logger.debug({ error }, "browser-router: refused");
    out.error(message);
    process.exit(1);
}

if (process.argv.length === 2) {
    process.argv.push("status");
}

await runTool(program, { tool: "browser-router" });
