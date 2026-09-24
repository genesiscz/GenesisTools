#!/usr/bin/env bun

import { runTool } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import {
    configFile,
    deleteRoute,
    ensureBuiltinRoutes,
    loadConfig,
    type RouteFlags,
    routeFromFlags,
    upsertRoute,
} from "./lib/config";
import { ensureRegisteredPort } from "./lib/ensure";
import { installRouterApp, restorePreviousBrowser, routerStatus } from "./lib/install";
import { launchOpen, openMintedLink, openUrl } from "./lib/launch";
import { convertMarkdown } from "./lib/links";
import { RouteError, route } from "./lib/route";
import { bundleUrls, saveBundle } from "./lib/tabs";
import { withTokenLock } from "./lib/tokens";

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
            out.println(routerStatus());
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
    .action(async () => {
        await printStatus();
    });

program
    .command("tabs")
    .description("Save or open a named set of links in one browser window")
    .argument("<action>", "save or open")
    .argument("<name>")
    .argument("[urls...]")
    .action(async (action: string, name: string, urls: string[]) => {
        try {
            if (action === "save") {
                await saveBundle(name, urls);
                out.println(`https://genesis.tools/tabs/${name}`);
                return;
            }
            if (action !== "open") {
                throw new Error("use save or open");
            }
            for (const url of bundleUrls(name)) {
                await launchOpen([url]);
            }
        } catch (error) {
            fail(error);
        }
    });

program
    .command("ensure")
    .description("Start the registered server on a port if it is not already listening")
    .argument("<port>")
    .action(async (portText: string) => {
        const result = await ensureRegisteredPort(Number(portText));
        if (!result.ok) {
            out.error(result.message);
            process.exitCode = result.code;
            return;
        }
        out.println(result.started ? `started ${result.name}` : `${result.name} is up`);
    });

program
    .command("presets")
    .description("Show built-in routes. A preset is hidden when its app is not installed.")
    .action(async () => {
        const { presets } = await import("./lib/presets");
        for (const preset of presets()) {
            out.println(`${preset.installed ? "on " : "off"}  ${preset.id}  ${preset.title}`);
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
    out.println(routerStatus());
    const config = await loadConfig();
    out.println(`routes=${config?.routes.length ?? 0}`);
}

function fail(error: unknown): never {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(message);
    out.error(message);
    process.exit(1);
}

if (process.argv.length === 2) {
    process.argv.push("status");
}

await runTool(program, { tool: "browser-router" });
