#!/usr/bin/env bun

import { extensionAdvice } from "@app/browser-extension/lib/host/loaded";
import { hasCapability } from "@genesiscz/utils/browser-router/capabilities";
import { configFile } from "@genesiscz/utils/browser-router/config";
import { tokenLink } from "@genesiscz/utils/browser-router/links";
import { presets, presetWarnings } from "@genesiscz/utils/browser-router/presets";
import { RouteError, route } from "@genesiscz/utils/browser-router/route";
import { routerStatus } from "@genesiscz/utils/browser-router/status";
import { mintBundleToken, withTokenLock } from "@genesiscz/utils/browser-router/tokens";
import { isInteractive, runTool, suggestCommand, suggestEnumFlag } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { ensureRegisteredPort, parsePort } from "@genesiscz/utils/services/ensure";
import { createBoxTable, formatDotStatus, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import { Command } from "commander";
import pc from "picocolors";
import {
    deleteRoute,
    disablePreset,
    enablePreset,
    ensureBuiltinRoutes,
    LINK_HOST_RISK,
    loadConfig,
    type RouteFlags,
    requireLinkHost,
    routeFromFlags,
    setLinkHost,
    upsertRoute,
} from "./lib/config";
import { displayRoutesTable } from "./lib/display";
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
            await offerLinkHost();
            out.println(
                `Presets are off until you switch them on. See them: ${suggestCommand("tools browser-router", {
                    replaceCommand: ["presets"],
                })}`
            );

            for (const line of extensionAdvice()) {
                out.println(line);
            }
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
    .description("Save a named bundle and print its link, https://<link host>/tabs/<name>")
    .argument("<name>", "A letter or digit, then letters, numbers, _ or -")
    .argument("[urls...]")
    .option("--from-md <file>", "Also take every http(s) link in this markdown file (- for stdin)")
    .action(async (name: string, urls: string[], options: { fromMd?: string }) => {
        try {
            const linkHost = requireLinkHost(await loadConfig());
            const all = await bundleInput(urls, options.fromMd);
            await saveBundle(name, all);
            out.println(bundleLink(name, linkHost));
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
            const linkHost = requireLinkHost(await loadConfig());
            const all = await bundleInput(urls, options.fromMd);
            const id = await withTokenLock(() => mintBundleToken(all, Number(options.uses)));
            out.println(tokenLink(id, linkHost));
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
    .action(async () => {
        try {
            const names = bundleNames();

            if (names.length === 0) {
                out.printlnErr(
                    `No saved bundles. Save one: ${suggestCommand("tools browser-router", {
                        replaceCommand: ["tabs", "save", "<name>", "<urls...>"],
                    })}`
                );
                return;
            }

            const linkHost = (await loadConfig())?.linkHost;

            for (const name of names) {
                const link = linkHost ? bundleLink(name, linkHost) : "(no link host)";
                out.println(`${name}  ${bundleUrls(name).length} links  ${link}`);
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
    .description("List the presets: default ones are always on, installable ones are off until enabled")
    .action(async () => {
        const config = await loadConfig();
        const catalogue = presets({ config });
        renderCliHeader("Browser Router Presets", config?.linkHost ? `link host ${config.linkHost}` : "no link host");
        const table = createBoxTable(["PRESET", "KIND", "STATE", "WHAT A CLICK DOES"]);

        for (const preset of catalogue) {
            const state = preset.enabled
                ? formatDotStatus("ok", "on")
                : preset.available
                  ? formatDotStatus("dim", "off")
                  : formatDotStatus("warn", `needs ${preset.missing.join(", ")}`);
            const chosen = config?.presets?.[preset.id];
            const extra = Object.entries(chosen?.names ?? {}).map(([name, key]) => `${name}=${key}`);
            const details = [
                ...(chosen?.only ? [`only ${chosen.only.join(", ")}`] : []),
                ...(extra.length > 0 ? [`names ${extra.join(", ")}`] : []),
            ].join("; ");
            const options = details ? ` (${details})` : "";
            table.push([
                pc.white(preset.id),
                preset.kind,
                state,
                truncateDisplay(`${preset.description}${options}`, 70),
            ]);
        }

        out.println(table.toString());

        for (const warning of presetWarnings(config, catalogue)) {
            out.println(formatDotStatus("warn", warning));
        }

        out.println(
            `Switch one on: ${suggestCommand("tools browser-router", { replaceCommand: ["presets", "enable", "<id>"] })}`
        );
    });

presetsCommand
    .command("enable")
    .description("Switch an installable preset on and write its routes")
    .argument("<id>")
    .option("--only <keys>", "local-services and dashboard-names: only these registry keys (comma-separated)")
    .option(
        "--name <name=key>",
        "dashboard-names: an extra name for a registry dashboard, e.g. dashboard=artifact-library (repeatable)",
        collect,
        [] as string[]
    )
    .action(async (id: string, options: { only?: string; name: string[] }) => {
        try {
            const only = options.only
                ?.split(",")
                .map((key) => key.trim())
                .filter(Boolean);
            const names = Object.fromEntries(
                options.name.map((pair) => {
                    const [name, key] = pair.split("=").map((part) => part.trim());

                    if (!name || !key) {
                        throw new Error(`--name takes name=key, got ${pair}`);
                    }

                    return [name, key];
                })
            );
            const saved = await enablePreset({
                id,
                options: { ...(only ? { only } : {}), ...(options.name.length > 0 ? { names } : {}) },
            });
            out.println(`Enabled ${id}: ${saved.routes.filter((rule) => rule.preset === id).length} route(s)`);
        } catch (error) {
            fail(error);
        }
    });

presetsCommand
    .command("sync")
    .description("Rewrite the saved routes from the presets (after a registry, link host or hand edit change)")
    .action(async () => {
        try {
            const saved = await ensureBuiltinRoutes();
            out.println(`${saved.routes.length} route(s)`);
        } catch (error) {
            fail(error);
        }
    });

presetsCommand
    .command("disable")
    .description("Switch an installable preset off and remove its routes")
    .argument("<id>")
    .action(async (id: string) => {
        try {
            await disablePreset(id);
            out.println(`Disabled ${id}`);
        } catch (error) {
            fail(error);
        }
    });

program
    .command("link-host")
    .description("Show or set the host every printed link is built on (https://<host>/t/<id>, /tabs/, /decide/, ...)")
    .argument("[host]", "A host name, e.g. links.example.com")
    .option("--accept-risk", "Set it without the confirmation (required without a terminal)")
    .option("--unset", "Remove the link host; no links are printed afterwards")
    .action(async (host: string | undefined, options: { acceptRisk?: boolean; unset?: boolean }) => {
        try {
            if (options.unset) {
                await setLinkHost(null);
                out.println("Link host removed");
                return;
            }

            if (!host) {
                const current = (await loadConfig())?.linkHost;
                out.println(current ?? "(no link host)");
                return;
            }

            if (!(await acceptLinkHostRisk(host, options.acceptRisk === true))) {
                process.exitCode = 1;
                return;
            }

            await setLinkHost(host);
            out.println(`Link host set to ${host}`);
        } catch (error) {
            fail(error);
        }
    });

/** Every link host carries the same risk; the confirmation is the user accepting it. */
async function acceptLinkHostRisk(host: string, accepted: boolean): Promise<boolean> {
    out.printlnErr(`${host}: ${LINK_HOST_RISK}`);

    if (accepted) {
        return true;
    }

    if (!isInteractive()) {
        out.error("Confirm with --accept-risk.");
        out.info(suggestCommand("tools browser-router", { replaceCommand: ["link-host", host, "--accept-risk"] }));
        return false;
    }

    const answer = await p.confirm({ message: `Build every link on ${host}?`, initialValue: false });
    return !p.isCancel(answer) && answer === true;
}

/** `install` asks for a link host once, in a terminal; without one it names the command. */
async function offerLinkHost(): Promise<void> {
    if ((await loadConfig())?.linkHost) {
        return;
    }

    const command = suggestCommand("tools browser-router", { replaceCommand: ["link-host", "<host>"] });

    if (!isInteractive()) {
        out.println(`No link host yet, so no links are printed. Set one: ${command}`);
        return;
    }

    const host = await p.text({ message: "Host to build links on (empty to skip)", placeholder: "links.example.com" });

    if (p.isCancel(host) || host.trim() === "") {
        out.println(`No link host set. Later: ${command}`);
        return;
    }

    if (await acceptLinkHostRisk(host.trim(), false)) {
        await setLinkHost(host.trim());
        out.println(`Link host set to ${host.trim()}`);
    }
}

const ROUTES_FORMATS = ["table", "json"] as const;

program
    .command("routes")
    .description("List the saved routes")
    .option("--format [format]", `table (default) or json: ${ROUTES_FORMATS.join(" | ")}`)
    .action(async (options: { format?: string }) => {
        const config = await loadConfig();

        if (!config) {
            out.println(`No config yet. ${configFile()}`);
            return;
        }

        if (options.format !== undefined && !(ROUTES_FORMATS as readonly string[]).includes(options.format)) {
            out.error(
                suggestEnumFlag("tools browser-router routes", "--format", ROUTES_FORMATS, {
                    subcommand: ["routes"],
                    given: options.format,
                })
            );
            process.exitCode = 1;
            return;
        }

        if (options.format === "json") {
            out.result(config.routes);
            return;
        }

        displayRoutesTable(config);
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
            const config = { ...saved, linkHost: requireLinkHost(saved) };
            const uses = options.uses === undefined ? undefined : Number(options.uses);
            const text = options.convert === "-" ? await Bun.stdin.text() : await Bun.file(options.convert).text();
            // Minting writes tokens.json, so it runs under the token lock.
            const converted =
                uses === undefined
                    ? convertMarkdown(text, config)
                    : await withTokenLock(() => convertMarkdown(text, config, uses));
            out.print(converted);

            if (converted !== text && !hasCapability("browser-extension:installed")) {
                out.warn(
                    `These links work when clicked in another app. Typed or clicked inside a browser they need the GenesisTools extension, which is not loaded: ${suggestCommand(
                        "tools browser-router",
                        { replaceCommand: ["status"] }
                    )}`
                );
            }
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
    .option("--no-toast", "Do not show the card for this route")
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
    .argument("<id>", "The id after /t/ in https://<link host>/t/<id>")
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
        throw new RouteError(
            `no config at ${configFile()}. Run: ${suggestCommand("tools browser-router", { replaceCommand: ["install"] })}`
        );
    }

    return config;
}

async function printStatus(): Promise<void> {
    out.println(`config=${configFile()}`);
    out.println(defaultBrowserStatus());
    const config = await loadConfig();
    out.println(`routes=${config?.routes.length ?? 0}`);
    out.println(
        `link-host=${config?.linkHost ?? `(none: ${suggestCommand("tools browser-router", { replaceCommand: ["link-host", "<host>"] })})`}`
    );
    const status = routerStatus({ config });
    out.println(
        // The presets whose links work now: switched on AND written into the routes, as `status --json` says.
        `presets=${status.enabledPresets.join(", ") || "(none)"}`
    );

    for (const preset of status.presets) {
        if (preset.drift.length === 0) {
            continue;
        }

        out.println(`drift ${preset.id}: ${preset.drift.join("; ")}`);
        out.println(
            preset.missing.length === 0
                ? `  fix: ${suggestCommand("tools browser-router", { replaceCommand: ["presets", "sync"] })}`
                : `  needs: ${preset.missing.join(", ")}`
        );
    }

    for (const line of extensionAdvice()) {
        out.println(line);
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
