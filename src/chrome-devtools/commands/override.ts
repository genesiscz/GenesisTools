/** emulate / intercept — overrides that live in this command's CDP session, so the command holds it open. */
import { setNetwork } from "@genesiscz/utils/chrome-devtools/emulate";
import {
    attachSourceMap,
    type InterceptAction,
    type InterceptHandle,
    intercept,
} from "@genesiscz/utils/chrome-devtools/intercept";
import {
    grantPermissions,
    isSecureOrigin,
    LOCAL_NETWORK_PERMISSIONS,
} from "@genesiscz/utils/chrome-devtools/permissions";
import { pickEnumFlag } from "@genesiscz/utils/cli/enum-flag";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";
import { cdpLikeOf } from "../lib/cdp-like-adapter.ts";
import {
    applyReplacements,
    carriedMapFor,
    collect,
    customNetwork,
    defaultStage,
    describeNetwork,
    type HoldOutcome,
    holdSession,
    INTERCEPT_STAGES,
    interceptMode,
    isInterceptStage,
    stageProblem,
} from "../lib/perf-cli.ts";
import { artifactPath } from "../lib/platform.ts";
import {
    applyEmulation,
    closeAndExit,
    type EmulationFlags,
    emulationPlan,
    restoreEmulation,
    withEmulationFlags,
} from "./perf.ts";
import { attachTab, positiveNumber, suggest, TOOL_CMD, withPage } from "./shared.ts";

const { log } = logger.scoped("chrome-devtools:override");

function holdSeconds(raw: string | undefined): number | undefined {
    return raw === undefined ? undefined : positiveNumber(raw, 0, "--seconds");
}

function holdLine(seconds: number | undefined): string {
    return `holding ${seconds === undefined ? "until Ctrl-C" : `for ${seconds} s (Ctrl-C ends it early)`}; the override ends when this command exits.`;
}

function outcomeLine(outcome: HoldOutcome): string {
    switch (outcome) {
        case "timeout":
            return "time is up";
        case "interrupted":
            return "Ctrl-C";
        case "detached":
            return "the tab went away";
    }
}

interface EmulateOptions extends EmulationFlags {
    port?: string;
    match?: string;
    latency?: string;
    down?: string;
    up?: string;
    offline?: boolean;
    seconds?: string;
}

function registerEmulate(program: Command): void {
    withEmulationFlags(
        withPage(program.command("emulate")).description(
            "throttle a tab's CPU and/or network while this command runs (DevTools Performance/Network throttling)"
        )
    )
        .option("--latency <ms>", "custom network: added round-trip latency")
        .option("--down <kbps>", "custom network: download limit in kbit/s")
        .option("--up <kbps>", "custom network: upload limit in kbit/s")
        .option("--offline", "custom network: no network at all")
        .option("--seconds <n>", "hold this long (default: until Ctrl-C)")
        .addHelpText(
            "after",
            `
Examples:
  ${suggest(["emulate", "--match", "localhost:3000", "--cpu", "4"])}
  ${suggest(["emulate", "--match", "localhost:3000", "--network", "slow-4g", "--seconds", "120"])}
  ${suggest(["emulate", "--match", "localhost:3000", "--latency", "300", "--down", "1600", "--up", "750"])}

Use it to try a page by hand on a slow machine or a bad network. The throttling belongs to this
command's CDP session: it stays on while the command runs and is reset when it exits. For measured
runs, pass --cpu/--network to 'perf load' or 'perf record' instead.`
        )
        .action(async (opts: EmulateOptions) => {
            const custom = customNetwork(opts);
            if ("error" in custom) {
                out.log.error(custom.error);
                process.exit(1);
            }

            if (custom.conditions && opts.network !== undefined) {
                out.log.error("--network takes a preset; --latency/--down/--up/--offline build a custom one. Use one.");
                process.exit(1);
            }

            const plan = await emulationPlan(opts, ["emulate"]);
            if (!plan) {
                return;
            }

            if (plan.cpu === 1 && !plan.network && !custom.conditions) {
                out.log.error("nothing to emulate: pass --cpu, --network, or --latency/--down/--up/--offline.");
                out.log.info(`  e.g. ${suggest(["emulate", "--cpu", "4", "--network", "fast-4g"])}`);
                process.exit(1);
            }

            const seconds = holdSeconds(opts.seconds);
            const page = await attachTab(opts);
            const cdp = cdpLikeOf(page);
            let failure: string | undefined;
            try {
                const active = await applyEmulation(cdp, plan);
                if (custom.conditions) {
                    const conditions = await setNetwork(cdp, custom.conditions);
                    active.push(`network ${describeNetwork(conditions)}`);
                }

                out.log.info(`active on ${page.target.url}:\n  ${active.join("\n  ")}`);
                out.log.info(holdLine(seconds));
                const outcome = await withInterrupt((signal) => holdSession({ seconds, signal, cdp }));
                log.debug({ outcome }, "emulate hold ended");
                out.log.info(`stopping: ${outcomeLine(outcome)}`);
            } catch (err) {
                failure = err instanceof Error ? err.message : String(err);
            } finally {
                await restoreEmulation(cdp);
            }

            if (failure) {
                out.log.error(`emulate failed: ${failure}`);
                closeAndExit(page, 1);
            }

            out.log.info("restored: CPU 1x, no network shaping");
            closeAndExit(page, 0);
        });
}

interface InterceptOptions {
    port?: string;
    match?: string;
    url?: string;
    mapDir?: string;
    replace: string[];
    bodyFile?: string;
    block?: boolean;
    stage?: string | boolean;
    seconds?: string;
}

function registerIntercept(program: Command): void {
    withPage(program.command("intercept"))
        .description("rewrite, replace or block matching requests of a tab while this command runs (CDP Fetch)")
        .option(
            "--url <glob>",
            "requests to catch: a glob, * matches any run, e.g. '*/config.js*' (--map-dir: '*.js*')"
        )
        .option(
            "--replace <rule>",
            "from=>to: rewrite the response body (from is a regex, to may use $1); repeatable",
            collect,
            []
        )
        .option("--body-file <file>", "answer with this file's content (content type from its extension)")
        .option("--block", "fail the request (BlockedByClient)")
        .option(
            "--map-dir <dir>",
            `attach the carried source maps in this folder (${toolCommand("ts", "sourcemaps", "carry")}) to the deployed scripts, for DevTools`
        )
        .option("--stage [stage]", "request | response (default: response for --replace, request otherwise)")
        .option("--seconds <n>", "hold this long (default: until Ctrl-C)")
        .addHelpText(
            "after",
            `
Examples:
  ${suggest(["intercept", "--match", "localhost:3000", "--url", "'*/config.js*'", "--replace", "'replay:true=>replay:false'"])}
  ${suggest(["intercept", "--match", "localhost:3000", "--url", "'*/api/cases*'", "--body-file", artifactPath("cases.json")])}
  ${suggest(["intercept", "--match", "localhost:3000", "--url", "'*sentry*'", "--block", "--seconds", "300"])}

Use it to test a fix or a config flip in the real page without deploying: reload the tab while it
holds. Each hit prints its url and action; the totals print at the end. Interception belongs to this
command's CDP session and stops when it exits. For measured comparisons use 'perf ab' rewrites.`
        )
        .action(async (opts: InterceptOptions) => {
            const chosen = interceptMode({
                replace: opts.replace,
                bodyFile: opts.bodyFile,
                block: opts.block,
                mapDir: opts.mapDir,
            });
            if ("error" in chosen) {
                out.log.error(chosen.error);
                out.log.info(
                    `  e.g. ${suggest(["intercept", "--url", "'*/data.json*'", "--replace", "'rows=>ROWS'"])}`
                );
                process.exit(1);
            }

            const mode = chosen.mode;
            const urlPattern = opts.url ?? (mode.kind === "map-dir" ? "*.js*" : undefined);
            if (!urlPattern) {
                out.log.error("--url <glob> is required (only --map-dir has a default, '*.js*').");
                process.exit(1);
            }

            let carried = new Map<string, string>();
            if (mode.kind === "map-dir") {
                const index = Bun.file(`${mode.dir}/index.json`);
                if (!(await index.exists())) {
                    out.log.error(
                        `${mode.dir}/index.json does not exist; write it with: ${toolCommand("ts", "sourcemaps", "carry", "--out", mode.dir)}`
                    );
                    process.exit(1);
                }

                const parsed = SafeJSON.parse(await index.text(), { strict: true }) as {
                    files?: Record<string, string>;
                };
                carried = new Map(Object.entries(parsed.files ?? {}));
            }
            const stage =
                opts.stage === undefined
                    ? defaultStage(mode)
                    : await pickEnumFlag({
                          tool: `${TOOL_CMD} intercept`,
                          subcommand: ["intercept"],
                          flag: "--stage",
                          given: opts.stage,
                          values: INTERCEPT_STAGES,
                          fallback: defaultStage(mode),
                          accepts: isInterceptStage,
                      });
            if (!stage) {
                return;
            }

            const problem = stageProblem(mode, stage);
            if (problem) {
                out.log.error(problem);
                process.exit(1);
            }

            let fileBody = "";
            let fileType = "";
            if (mode.kind === "body-file") {
                const file = Bun.file(mode.path);
                if (!(await file.exists())) {
                    out.log.error(`--body-file ${mode.path} does not exist.`);
                    process.exit(1);
                }

                fileBody = await file.text();
                fileType = file.type;
            }

            const seconds = holdSeconds(opts.seconds);
            const page = await attachTab(opts);
            const cdp = cdpLikeOf(page);
            const started = performance.now();
            const stamp = (): string => pc.dim(`+${((performance.now() - started) / 1000).toFixed(1)}s`.padStart(8));
            const hit = (action: string, method: string, url: string, detail = ""): void => {
                out.println(`${stamp()} ${action.padEnd(8)} ${method} ${url}${detail ? `  ${pc.dim(detail)}` : ""}`);
            };

            const handleHit = async (context: {
                url: string;
                method: string;
                body?(): Promise<string>;
            }): Promise<InterceptAction> => {
                if (mode.kind === "block") {
                    hit(pc.red("BLOCK"), context.method, context.url);
                    return { action: "fail", reason: "BlockedByClient" };
                }

                if (mode.kind === "body-file") {
                    hit(pc.green("FULFILL"), context.method, context.url, `<- ${mode.path} (${fileBody.length} chars)`);
                    return { action: "fulfill", body: fileBody, headers: { "content-type": fileType } };
                }

                if (mode.kind === "map-dir") {
                    const mapPath = carriedMapFor(carried, context.url);
                    if (!mapPath) {
                        hit("PASS", context.method, context.url, "no carried map for this file");
                        return { action: "continue" };
                    }

                    const map = await Bun.file(`${mode.dir}/${mapPath}`).text();
                    const original = context.body ? await context.body() : "";
                    hit(pc.green("MAP"), context.method, context.url, `+ ${mapPath}`);
                    return {
                        action: "fulfill",
                        body: attachSourceMap(original, map),
                        headers: { "cache-control": "no-store" },
                    };
                }

                const original = context.body ? await context.body() : "";
                const applied = applyReplacements(original, mode.rules);
                if (applied.replaced === 0) {
                    hit("PASS", context.method, context.url, "no rule matched; original response");
                    return { action: "continue" };
                }

                hit(pc.green("REWRITE"), context.method, context.url, `${applied.replaced} replacement(s)`);
                return { action: "fulfill", body: applied.body, headers: { "cache-control": "no-store" } };
            };

            let handle: InterceptHandle | undefined;
            let failure: string | undefined;
            try {
                handle = await intercept(cdp, [{ urlPattern, stage, handle: handleHit }]);
                const action =
                    mode.kind === "replace"
                        ? mode.rules.map((rule) => `'${rule.from}' -> '${rule.to}'`).join(", ")
                        : mode.kind === "body-file"
                          ? `answer with ${mode.path}`
                          : mode.kind === "map-dir"
                            ? `attach ${carried.size} carried map(s) from ${mode.dir} (reload the tab, then open Sources)`
                            : "block";
                out.log.info(`intercepting ${urlPattern} at the ${stage} stage on ${page.target.url}: ${action}`);
                out.log.info(holdLine(seconds));
                const outcome = await withInterrupt((signal) => holdSession({ seconds, signal, cdp }));
                log.debug({ outcome }, "intercept hold ended");
                out.log.info(`stopping: ${outcomeLine(outcome)}`);
            } catch (err) {
                failure = err instanceof Error ? err.message : String(err);
            } finally {
                await handle?.stop().catch((err: unknown) => log.debug({ err }, "intercept stop failed"));
            }

            if (handle) {
                const stats = handle.stats;
                out.log.info(
                    `caught ${stats.paused} · answered ${stats.fulfilled} · passed ${stats.continued} · failed ${stats.failed}`
                );
                for (const error of stats.errors) {
                    out.log.warn(`  rule error: ${error}`);
                }
            }

            if (failure) {
                out.log.error(`intercept failed: ${failure}`);
                closeAndExit(page, 1);
            }

            closeAndExit(page, 0);
        });
}

interface GrantOptions {
    port?: string;
    match?: string;
    origin?: string;
    seconds?: string;
}

/** The origin of a URL, or null when it is not an absolute http(s) URL (`app.example.com` has no scheme). */
function originOf(raw: string): string | null {
    try {
        const url = new URL(raw);
        return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
    } catch {
        return null;
    }
}

function registerGrant(program: Command): void {
    withPage(program.command("grant"))
        .description(
            "grant browser permissions to a tab's origin while this command runs (default: Local Network Access)"
        )
        .argument(
            "[permissions...]",
            `Permissions API names (default: ${LOCAL_NETWORK_PERMISSIONS.join(" ")}); e.g. geolocation, notifications`
        )
        .option("--origin <url>", "the origin to grant (default: the tab's own origin)")
        .option("--seconds <n>", "hold this long (default: until Ctrl-C)")
        .addHelpText(
            "after",
            `
A public HTTPS page that calls a private address (10.x, 192.168.x, a host resolving there) needs
local-network; one that calls 127.0.0.1 or localhost needs loopback-network (Chrome 145+). A blocked call
fails with corsError LocalNetworkAccessPermissionDenied, which 'follow' marks on its FAIL lines.
The grant keeps the profile's protection: it covers one origin, and Chrome drops it when this command
exits. Unlike --disable-features=LocalNetworkAccessChecks, it also lets an HTTPS page reach an HTTP
private address (with the checks merely off, that is still blocked as mixed content).

Examples:
  ${suggest(["grant", "--match", "app.example.com"])}
  ${suggest(["grant", "local-network", "--match", "app.example.com", "--seconds", "600"])}`
        )
        .action(async (permissions: string[], opts: GrantOptions) => {
            const names = permissions.length > 0 ? permissions : [...LOCAL_NETWORK_PERMISSIONS];
            const seconds = holdSeconds(opts.seconds);
            const given = opts.origin ? originOf(opts.origin) : undefined;
            if (opts.origin && !given) {
                out.log.error(`--origin needs a full origin with its scheme, e.g. https://${opts.origin}`);
                out.log.info(`  e.g. ${suggest(["grant", "--origin", `https://${opts.origin}`])}`);
                process.exit(1);
            }

            const page = await attachTab(opts);
            const origin = given ?? originOf(page.target.url);
            if (!origin) {
                out.log.error(`the tab has no web origin (${page.target.url}); pass --origin https://<host>`);
                closeAndExit(page, 1);
            }

            if (!isSecureOrigin(origin)) {
                out.log.error(
                    `${origin} is not a secure origin; Chrome grants permissions only to https (or http on localhost).`
                );
                closeAndExit(page, 1);
            }

            const cdp = cdpLikeOf(page);
            const results = await grantPermissions(cdp, { origin, names });
            for (const result of results) {
                if (result.granted) {
                    out.log.info(`granted ${result.name} to ${origin}`);
                } else {
                    out.log.error(`${result.name}: ${result.error}`);
                }
            }

            if (!results.some((result) => result.granted)) {
                closeAndExit(page, 1);
            }

            out.log.info(holdLine(seconds));
            const outcome = await withInterrupt((signal) => holdSession({ seconds, signal, cdp }));
            log.debug({ outcome }, "grant hold ended");
            out.log.info(`stopping: ${outcomeLine(outcome)}; Chrome drops the grant with this session`);
            closeAndExit(page, results.every((result) => result.granted) ? 0 : 1);
        });
}

export function registerOverrides(program: Command): void {
    registerEmulate(program);
    registerIntercept(program);
    registerGrant(program);
}
